const { io } = require('socket.io-client');
const {
    summarizeResponsesWithChatGPT,
    parseSummary
} = require('./summarize');

const FOLLOW_UP_PROMPT = 'Which one is the best?';
const CON_TAG = '[Con]';
const TEXT_SUBMIT_LABEL = 'Submit response';
const COLORS = ['#00ff00', '#00ffff', '#ffff00', '#ff0000'];
const MODES = new Set(['never', 'always', 'con']);
const DISCONNECT_GRACE_MS = 5000;
const CLASS_REFRESH_MS = 10000;
const DEFAULT_AUTO_END_SECONDS = 5;
const DEFAULT_AUTO_END_PERCENT = 80;

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

function isPollActive(poll) {
    return Boolean(poll && poll.status !== false);
}

function isPollComplete(poll) {
    if (!isPollActive(poll)) return false;

    const totalResponses = Number(poll.totalResponses);
    const totalResponders = Number(poll.totalResponders);

    return Number.isFinite(totalResponses)
        && Number.isFinite(totalResponders)
        && totalResponses > 0
        && totalResponses >= totalResponders;
}

function responsePercent(poll) {
    const totalResponses = Number(poll && poll.totalResponses) || 0;
    const totalResponders = Number(poll && poll.totalResponders) || 0;
    if (totalResponders <= 0) return 0;
    return (totalResponses / totalResponders) * 100;
}

function isFollowUpPoll(poll) {
    return poll?.prompt === FOLLOW_UP_PROMPT;
}

function pollKey(data) {
    if (!data || !data.poll) return null;
    return `${data.id || 'class'}::${data.poll.prompt || ''}`;
}

function isMatchingPoll(poll, mode) {
    if (!isPollActive(poll)) return false;
    if (isFollowUpPoll(poll)) return false;
    if (!poll.allowTextResponses) return false;
    if (mode === 'never') return false;
    if (mode === 'con') {
        return String(poll.prompt || '').trim().startsWith(CON_TAG);
    }
    return true;
}

function hasConTag(prompt) {
    return String(prompt || '').trim().startsWith(CON_TAG);
}

function buildSeedPrompt(prompt, mode) {
    const raw = String(prompt || '').trim();
    if (!raw) return '';
    if (mode === 'con' && !hasConTag(raw)) {
        return `${CON_TAG} ${raw}`;
    }
    return raw;
}

function textPollPayload(prompt) {
    return {
        prompt,
        answers: [
            {
                answer: TEXT_SUBMIT_LABEL,
                weight: 1,
                color: '#00ff00',
                correct: false
            }
        ],
        blind: false,
        weight: 1,
        tags: [],
        excludedRespondents: [],
        indeterminate: [],
        allowVoteChanges: true,
        allowTextResponses: true,
        allowMultipleResponses: false
    };
}

function clearAutoEndTimer(listener) {
    if (listener.autoEndTimer) {
        clearTimeout(listener.autoEndTimer);
        listener.autoEndTimer = null;
    }
    listener.autoEndDeadline = null;
    listener.autoEndForKey = null;
}

function endFormbarPoll(listener) {
    const socket = listener.formbarSocket;
    if (!socket || !socket.connected) return false;
    socket.emit('updatePoll', { status: false });
    return true;
}

function startTextPoll(listener, prompt) {
    const socket = listener.formbarSocket;
    if (!socket || !socket.connected) {
        emitError(listener, 'Formbar is not connected; could not start the poll.');
        return false;
    }
    socket.emit('startPoll', textPollPayload(prompt));
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
    const hasActivePoll = isPollActive(poll);
    const percent = matching ? responsePercent(poll) : 0;
    const autoEndArmed = Boolean(
        listener.autoEndEnabled
        && matching
        && listener.autoEndDeadline
        && listener.autoEndForKey === pollKey(data)
    );

    return {
        user: listener.displayName,
        mode: listener.mode,
        className: displayClassName(listener),
        classId: data && data.id != null ? data.id : listener.classId,
        formbarConnected: Boolean(listener.formbarSocket && listener.formbarSocket.connected),
        autoEndEnabled: listener.autoEndEnabled,
        autoEndSeconds: listener.autoEndSeconds,
        autoEndPercent: listener.autoEndPercent,
        autoEndArmed,
        autoEndRemainingMs: autoEndArmed
            ? Math.max(0, listener.autoEndDeadline - Date.now())
            : null,
        startEnabled: Boolean(
            listener.formbarSocket
            && listener.formbarSocket.connected
            && listener.classId != null
            && !listener.sendingToAi
            && !listener.starting
        ),
        starting: Boolean(listener.starting),
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
                percent: Math.round(percent),
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

    clearAutoEndTimer(listener);

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

function maybeArmAutoEnd(listener, data) {
    const poll = data && data.poll;
    if (!listener.autoEndEnabled || !isMatchingPoll(poll, listener.mode)) {
        clearAutoEndTimer(listener);
        return;
    }

    const key = pollKey(data);
    if (!key || listener.sentResultKey === key || listener.alreadySentKey === key || listener.sendingToAi) {
        clearAutoEndTimer(listener);
        return;
    }

    const percent = responsePercent(poll);
    if (percent < listener.autoEndPercent) {
        clearAutoEndTimer(listener);
        return;
    }

    if (listener.autoEndForKey === key && listener.autoEndTimer) {
        return;
    }

    clearAutoEndTimer(listener);
    const seconds = Math.max(0, Number(listener.autoEndSeconds) || 0);
    listener.autoEndForKey = key;
    listener.autoEndDeadline = Date.now() + (seconds * 1000);
    listener.statusMessage = `${Math.round(percent)}% responded. Sending to AI in ${seconds}s…`;
    emitState(listener);

    listener.autoEndTimer = setTimeout(() => {
        listener.autoEndTimer = null;
        listener.autoEndDeadline = null;
        const latest = listener.lastClassData;
        if (!latest || pollKey(latest) !== key) return;
        if (listener.sentResultKey === key || listener.alreadySentKey === key || listener.sendingToAi) return;
        if (!isMatchingPoll(latest.poll, listener.mode)) return;
        sendToAi(listener, latest, { forced: true });
    }, seconds * 1000);
}

function handleClassUpdate(listener, data) {
    if (!data) {
        listener.lastClassData = null;
        clearAutoEndTimer(listener);
        listener.statusMessage = 'Join a class in Formbar.';
        emitState(listener);
        return;
    }

    const key = pollKey(data);
    if (!key) {
        listener.pollEnded = true;
        clearAutoEndTimer(listener);
    } else {
        const pollChanged = listener.pollEnded || (listener.lastPollKey && key !== listener.lastPollKey);
        if (pollChanged) {
            listener.alreadySentKey = null;
            listener.sentResultKey = null;
            clearAutoEndTimer(listener);
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
        clearAutoEndTimer(listener);
        listener.statusMessage = classLabel
            ? `Listening paused. Current class: ${classLabel}.`
            : 'Listening paused.';
        emitState(listener);
        return;
    }

    if (!isPollActive(poll)) {
        clearAutoEndTimer(listener);
        listener.statusMessage = classLabel
            ? `${classLabel}: no active poll.`
            : 'No active poll.';
        emitState(listener);
        return;
    }

    if (isFollowUpPoll(poll)) {
        clearAutoEndTimer(listener);
        listener.statusMessage = 'Follow-up poll is running in Formbar.';
        emitState(listener);
        return;
    }

    if (!matching) {
        clearAutoEndTimer(listener);
        listener.statusMessage = listener.mode === 'con'
            ? `Current poll does not start with ${CON_TAG}.`
            : 'Current poll is not a text poll.';
        emitState(listener);
        return;
    }

    const responses = collectStudentTextResponses(data.students);
    const percent = Math.round(responsePercent(poll));
    listener.statusMessage = `${responses.length} response${responses.length === 1 ? '' : 's'} · ${percent}% of class.`;
    emitState(listener);

    if (listener.sendingToAi || listener.alreadySentKey === key || listener.sentResultKey === key) return;

    if (isPollComplete(poll)) {
        clearAutoEndTimer(listener);
        sendToAi(listener, data, { forced: false });
        return;
    }

    maybeArmAutoEnd(listener, data);
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
    clearAutoEndTimer(listener);

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
            clearAutoEndTimer(listener);
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
        autoEndEnabled: true,
        autoEndSeconds: DEFAULT_AUTO_END_SECONDS,
        autoEndPercent: DEFAULT_AUTO_END_PERCENT,
        autoEndTimer: null,
        autoEndDeadline: null,
        autoEndForKey: null,
        starting: false,
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
        if (mode === 'never') clearAutoEndTimer(listener);
        handleClassUpdate(listener, listener.lastClassData);
    });

    browserSocket.on('setAutoEnd', (settings) => {
        if (!settings || typeof settings !== 'object') return;
        if (typeof settings.enabled === 'boolean') {
            listener.autoEndEnabled = settings.enabled;
        }
        if (settings.seconds != null) {
            const seconds = Number(settings.seconds);
            if (Number.isFinite(seconds) && seconds >= 0) {
                listener.autoEndSeconds = Math.min(600, Math.floor(seconds));
            }
        }
        if (settings.percent != null) {
            const percent = Number(settings.percent);
            if (Number.isFinite(percent) && percent > 0 && percent <= 100) {
                listener.autoEndPercent = Math.floor(percent);
            }
        }
        clearAutoEndTimer(listener);
        handleClassUpdate(listener, listener.lastClassData);
    });

    browserSocket.on('startQuestion', (payload) => {
        const rawPrompt = payload && typeof payload.prompt === 'string'
            ? payload.prompt
            : (typeof payload === 'string' ? payload : '');
        if (!String(rawPrompt || '').trim()) {
            emitError(listener, 'Enter a prompt to start.');
            return;
        }
        if (!listener.formbarSocket || !listener.formbarSocket.connected) {
            emitError(listener, 'Formbar is not connected.');
            return;
        }
        if (listener.classId == null) {
            emitError(listener, 'Join a class in Formbar first.');
            return;
        }
        if (listener.sendingToAi || listener.starting) {
            emitError(listener, 'Already starting a poll or sending responses.');
            return;
        }

        // Starting a question turns listening on if it was off.
        if (listener.mode === 'never') {
            listener.mode = 'always';
        }

        const prompt = buildSeedPrompt(rawPrompt, listener.mode);

        clearAutoEndTimer(listener);
        listener.generatedAnswers = null;
        listener.cachedResponses = null;
        listener.cachedResponsesPrompt = null;
        listener.alreadySentKey = null;
        listener.sentResultKey = null;
        listener.starting = true;
        listener.statusMessage = 'Starting text poll…';
        emitState(listener);

        const begin = () => {
            const started = startTextPoll(listener, prompt);
            listener.starting = false;
            if (started) {
                listener.statusMessage = `Text poll started: ${prompt}`;
            }
            emitState(listener);
        };

        if (listener.lastClassData && isPollActive(listener.lastClassData.poll)) {
            endFormbarPoll(listener);
            setTimeout(begin, 400);
            return;
        }

        begin();
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
    clearAutoEndTimer(listener);
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
