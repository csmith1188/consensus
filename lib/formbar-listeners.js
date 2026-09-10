const { io } = require('socket.io-client');
const {
    summarizeResponsesWithChatGPT,
    parseSummary
} = require('./summarize');

const FOLLOW_UP_PROMPT = 'Which one is the best?';
const COLORS = ['#00ff00', '#00ffff', '#ffff00', '#ff0000'];
const MODES = new Set(['never', 'always', 'con']);
const DISCONNECT_GRACE_MS = 5000;
const CLASS_REFRESH_MS = 10000;

function normalizeClassId(value) {
    if (value == null || value === '' || value === false) return null;
    return value;
}

function classNameFromData(data) {
    if (!data || typeof data !== 'object') return null;
    return data.className || data.name || null;
}

function displayClassName(listener) {
    const data = listener.lastClassData;
    const name = classNameFromData(data);
    if (name) return name;
    const classId = data && data.id != null ? data.id : listener.classId;
    if (classId != null && classId !== '') return `Class ${classId}`;
    return null;
}

function requestActiveClass(listener) {
    const socket = listener.formbarSocket;
    if (!socket || !socket.connected) return;
    socket.emit('getActiveClass', listener.apiKey);
}

const listeners = new Map();

function getStudentText(pollRes) {
    if (!pollRes || typeof pollRes !== 'object') return '';
    const candidates = [pollRes.textRes, pollRes.text, pollRes.textResponse];
    for (const value of candidates) {
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return '';
}

function collectStudentTextResponses(students) {
    const textResponses = [];

    for (const student of Object.values(students || {})) {
        const response = getStudentText(student.pollRes);
        if (response) {
            textResponses.push({
                studentName: student.displayName || 'Student',
                response
            });
        }
    }

    return textResponses;
}

function isPollComplete(poll) {
    if (!poll || poll.status === false) return false;

    const totalResponses = Number(poll.totalResponses);
    const totalResponders = Number(poll.totalResponders);

    return Number.isFinite(totalResponses)
        && Number.isFinite(totalResponders)
        && totalResponses > 0
        && totalResponses >= totalResponders;
}

function isFollowUpPoll(poll) {
    return poll?.prompt === FOLLOW_UP_PROMPT;
}

function pollKey(data) {
    if (!data || !data.poll) return null;
    return `${data.id || 'class'}::${data.poll.prompt || ''}`;
}

function isMatchingPoll(poll, mode) {
    if (!poll || poll.status === false) return false;
    if (isFollowUpPoll(poll)) return false;
    if (!poll.allowTextResponses) return false;
    if (mode === 'never') return false;
    if (mode === 'con') {
        return String(poll.prompt || '').trim().startsWith('[Con]');
    }
    return true;
}

function startFollowUpPoll(socket, result) {
    const pollAnswers = result.answers.map((answer, index) => {
        const correct = Boolean(result.correctAnswer) && answer === result.correctAnswer;
        return {
            answer,
            weight: correct ? 3 : 1,
            color: COLORS[index] || '#cccccc',
            correct
        };
    });

    socket.emit('startPoll', {
        prompt: FOLLOW_UP_PROMPT,
        answers: pollAnswers,
        blind: false,
        weight: 1,
        tags: [],
        excludedRespondents: [],
        indeterminate: [],
        allowVoteChanges: true,
        allowTextResponses: false,
        allowMultipleResponses: false
    });
}

function publicState(listener) {
    const data = listener.lastClassData;
    const poll = data && data.poll;
    const matching = isMatchingPoll(poll, listener.mode);
    const followUp = isFollowUpPoll(poll);
    const liveResponses = matching ? collectStudentTextResponses(data.students) : [];
    if (matching && liveResponses.length > 0) {
        listener.cachedResponses = liveResponses;
        listener.cachedResponsesPrompt = poll.prompt || '';
    }
    const responses = matching
        ? liveResponses
        : ((followUp || listener.generatedAnswers) && listener.cachedResponses
            ? listener.cachedResponses
            : []);
    const hasActivePoll = Boolean(poll && poll.status !== false);

    return {
        user: listener.displayName,
        mode: listener.mode,
        className: displayClassName(listener),
        classId: data && data.id != null ? data.id : listener.classId,
        formbarConnected: Boolean(listener.formbarSocket && listener.formbarSocket.connected),
        poll: matching || (hasActivePoll && listener.mode !== 'never' && followUp)
            ? {
                prompt: matching
                    ? (poll.prompt || '')
                    : (listener.cachedResponsesPrompt || poll.prompt || ''),
                totalResponses: matching
                    ? (Number(poll.totalResponses) || 0)
                    : (listener.cachedResponses ? listener.cachedResponses.length : 0),
                totalResponders: matching
                    ? (Number(poll.totalResponders) || 0)
                    : (listener.cachedResponses ? listener.cachedResponses.length : 0),
                matching,
                isFollowUp: followUp
            }
            : (hasActivePoll && listener.mode === 'always' && !poll.allowTextResponses
                ? {
                    prompt: poll.prompt || '',
                    totalResponses: Number(poll.totalResponses) || 0,
                    totalResponders: Number(poll.totalResponders) || 0,
                    matching: false,
                    isFollowUp: followUp
                }
                : null),
        responses,
        answers: listener.generatedAnswers,
        sendingToAi: listener.sendingToAi,
        alreadySent: Boolean(listener.sentResultKey && listener.sentResultKey === pollKey(data)),
        forceSendEnabled: listener.mode !== 'never'
            && matching
            && liveResponses.length > 0
            && !listener.sendingToAi
            && listener.sentResultKey !== pollKey(data),
        statusMessage: listener.statusMessage
    };
}

function emitState(listener) {
    const state = publicState(listener);
    for (const browser of listener.browserSockets) {
        browser.emit('state', state);
    }
}

function emitError(listener, message) {
    for (const browser of listener.browserSockets) {
        browser.emit('appError', { message });
    }
}

async function sendToAi(listener, data, { forced }) {
    const key = pollKey(data);
    if (!key || listener.sendingToAi) return;
    if (listener.sentResultKey === key) return;
    if (!forced && listener.alreadySentKey === key) return;

    const textResponses = collectStudentTextResponses(data.students);
    if (textResponses.length === 0) {
        emitError(listener, 'No text responses to send yet.');
        return;
    }

    listener.cachedResponses = textResponses;
    listener.cachedResponsesPrompt = data.poll && data.poll.prompt ? data.poll.prompt : '';
    listener.alreadySentKey = key;
    listener.sendingToAi = true;
    listener.statusMessage = forced
        ? 'Sending current responses to AI…'
        : 'Poll complete. Sending responses to AI…';
    emitState(listener);

    try {
        const pollPrompt = data.poll.prompt || 'No prompt provided';
        const summary = await summarizeResponsesWithChatGPT(textResponses, pollPrompt);
        const result = parseSummary(summary, textResponses);

        if (!result || result.answers.length === 0) {
            listener.statusMessage = 'Could not parse answers from AI.';
            emitError(listener, listener.statusMessage);
            emitState(listener);
            return;
        }

        listener.generatedAnswers = {
            answers: result.answers,
            correctAnswer: result.correctAnswer || '',
            correctAnswerListed: Boolean(result.correctAnswerListed),
            badAnswers: result.badAnswers || []
        };
        listener.sentResultKey = key;
        listener.statusMessage = forced
            ? 'Follow-up poll started from current responses.'
            : 'Follow-up poll started.';

        if (listener.formbarSocket && listener.formbarSocket.connected) {
            startFollowUpPoll(listener.formbarSocket, result);
        } else {
            emitError(listener, 'Generated answers, but Formbar is not connected to start the follow-up poll.');
        }

        emitState(listener);
    } catch (error) {
        listener.statusMessage = error.message || 'Failed to send responses to AI.';
        emitError(listener, listener.statusMessage);
        emitState(listener);
    } finally {
        listener.sendingToAi = false;
        emitState(listener);
    }
}

function handleClassUpdate(listener, data) {
    if (!data) {
        listener.lastClassData = null;
        listener.statusMessage = 'Join a class in Formbar.';
        emitState(listener);
        return;
    }

    const key = pollKey(data);
    if (!key) {
        listener.pollEnded = true;
    } else {
        const pollChanged = listener.pollEnded || (listener.lastPollKey && key !== listener.lastPollKey);
        if (pollChanged) {
            listener.alreadySentKey = null;
            listener.sentResultKey = null;
            // Keep cached responses across the AI follow-up poll; clear for any other new poll.
            if (!isFollowUpPoll(data.poll)) {
                listener.cachedResponses = null;
                listener.cachedResponsesPrompt = null;
                listener.generatedAnswers = null;
            }
        }
        listener.pollEnded = false;
        listener.lastPollKey = key;
    }

    listener.lastClassData = data;
    listener.classId = data.id != null ? data.id : listener.classId;

    const poll = data.poll;
    const matching = isMatchingPoll(poll, listener.mode);
    const classLabel = displayClassName(listener);

    if (listener.mode === 'never') {
        listener.statusMessage = classLabel
            ? `Listening paused. Current class: ${classLabel}.`
            : 'Listening paused.';
        emitState(listener);
        return;
    }

    if (!poll || poll.status === false) {
        listener.statusMessage = classLabel
            ? `${classLabel}: no active poll.`
            : 'No active poll.';
        emitState(listener);
        return;
    }

    if (isFollowUpPoll(poll)) {
        listener.statusMessage = 'Follow-up poll is running in Formbar.';
        emitState(listener);
        return;
    }

    if (!matching) {
        listener.statusMessage = listener.mode === 'con'
            ? 'Current poll does not start with [Con].'
            : 'Current poll is not a text poll.';
        emitState(listener);
        return;
    }

    const responses = collectStudentTextResponses(data.students);
    listener.statusMessage = `${responses.length} response${responses.length === 1 ? '' : 's'} collected.`;
    emitState(listener);

    if (!isPollComplete(poll)) return;
    if (listener.alreadySentKey === key) return;

    sendToAi(listener, data, { forced: false });
}

function connectFormbar(listener, formbarUrl) {
    if (listener.formbarSocket) {
        listener.formbarSocket.removeAllListeners();
        listener.formbarSocket.disconnect();
    }
    if (listener.classRefreshTimer) {
        clearInterval(listener.classRefreshTimer);
        listener.classRefreshTimer = null;
    }

    if (!listener.apiKey) {
        listener.statusMessage = 'Formbar API key is missing. Add API_KEY to .env.';
        emitState(listener);
        emitError(listener, listener.statusMessage);
        return;
    }

    const socket = io(formbarUrl, {
        extraHeaders: {
            api: listener.apiKey
        },
        autoConnect: false
    });

    listener.formbarSocket = socket;

    socket.on('connect', () => {
        listener.statusMessage = 'Connected to Formbar.';
        requestActiveClass(listener);
        emitState(listener);
        if (!listener.classRefreshTimer) {
            listener.classRefreshTimer = setInterval(() => {
                requestActiveClass(listener);
            }, CLASS_REFRESH_MS);
        }
    });

    socket.on('setClass', (newClassId) => {
        const classId = normalizeClassId(newClassId);
        listener.classId = classId;
        if (classId == null) {
            if (listener.jwtActiveClass != null && !listener.triedJoinClass) {
                listener.triedJoinClass = true;
                socket.emit('joinClass', listener.jwtActiveClass);
            }
            listener.lastClassData = listener.lastClassData && {
                ...listener.lastClassData,
                id: null,
                className: null,
                name: null,
                poll: null,
                students: {}
            };
            listener.statusMessage = 'No current classroom. Join a class in Formbar.';
            emitState(listener);
            return;
        }
        listener.triedJoinClass = false;
        socket.emit('classUpdate');
        emitState(listener);
    });

    socket.on('startPoll', () => {
        listener.statusMessage = 'Follow-up poll started.';
        emitState(listener);
    });

    socket.on('error', (error) => {
        const message = error && error.message ? error.message : String(error);
        emitError(listener, `Formbar: ${message}`);
    });

    socket.on('connect_error', (error) => {
        listener.statusMessage = `Formbar connection error: ${error.message}`;
        emitState(listener);
        setTimeout(() => {
            if (listener.formbarSocket === socket && listener.browserSockets.size > 0) {
                socket.connect();
            }
        }, 5000);
    });

    socket.on('classUpdate', (data) => {
        handleClassUpdate(listener, data);
    });

    socket.connect();
}

function createListener(user, formbarUrl, apiKey) {
    const activeClass = normalizeClassId(user.activeClass);
    const listener = {
        formbarId: user.formbarId,
        displayName: user.displayName,
        rawJwt: user.rawJwt,
        apiKey: apiKey || '',
        jwtActiveClass: activeClass,
        triedJoinClass: false,
        mode: 'always',
        formbarSocket: null,
        browserSockets: new Set(),
        lastClassData: null,
        generatedAnswers: null,
        cachedResponses: null,
        cachedResponsesPrompt: null,
        sendingToAi: false,
        alreadySentKey: null,
        sentResultKey: null,
        lastPollKey: null,
        pollEnded: false,
        classId: activeClass,
        classRefreshTimer: null,
        statusMessage: 'Connecting to Formbar…',
        disconnectTimer: null
    };

    connectFormbar(listener, formbarUrl);
    return listener;
}

function attachBrowser(user, browserSocket, formbarUrl, apiKey) {
    const id = String(user.formbarId);
    let listener = listeners.get(id);

    if (!listener) {
        listener = createListener(user, formbarUrl, apiKey);
        listeners.set(id, listener);
    } else {
        listener.rawJwt = user.rawJwt;
        listener.displayName = user.displayName;
        listener.apiKey = apiKey || listener.apiKey;
        listener.jwtActiveClass = normalizeClassId(user.activeClass) != null
            ? normalizeClassId(user.activeClass)
            : listener.jwtActiveClass;
        if (listener.classId == null && listener.jwtActiveClass != null) {
            listener.classId = listener.jwtActiveClass;
        }
        if (listener.disconnectTimer) {
            clearTimeout(listener.disconnectTimer);
            listener.disconnectTimer = null;
        }
        if (!listener.formbarSocket || !listener.formbarSocket.connected) {
            connectFormbar(listener, formbarUrl);
        }
    }

    listener.browserSockets.add(browserSocket);
    emitState(listener);

    browserSocket.on('setMode', (mode) => {
        if (!MODES.has(mode)) return;
        listener.mode = mode;
        handleClassUpdate(listener, listener.lastClassData);
    });

    browserSocket.on('forceSend', () => {
        const data = listener.lastClassData;
        if (!data || !isMatchingPoll(data.poll, listener.mode)) {
            emitError(listener, 'No matching text poll to send.');
            return;
        }
        sendToAi(listener, data, { forced: true });
    });

    browserSocket.on('disconnect', () => {
        listener.browserSockets.delete(browserSocket);
        if (listener.browserSockets.size === 0) {
            listener.disconnectTimer = setTimeout(() => {
                if (listener.browserSockets.size === 0) {
                    stopListener(id);
                }
            }, DISCONNECT_GRACE_MS);
        }
    });
}

function stopListener(formbarId) {
    const id = String(formbarId);
    const listener = listeners.get(id);
    if (!listener) return;

    if (listener.disconnectTimer) {
        clearTimeout(listener.disconnectTimer);
    }
    if (listener.classRefreshTimer) {
        clearInterval(listener.classRefreshTimer);
        listener.classRefreshTimer = null;
    }
    if (listener.formbarSocket) {
        listener.formbarSocket.removeAllListeners();
        listener.formbarSocket.disconnect();
    }
    listeners.delete(id);
}

module.exports = {
    attachBrowser,
    stopListener
};
