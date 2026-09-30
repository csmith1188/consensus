const HELP = {
    start: {
        title: 'Start',
        body: 'Enter a question and start a Formbar text poll from this page. When enough students respond, Consensus sends their answers to AI and starts the follow-up poll. In [Con] listen mode, the tag is added automatically if you leave it off.'
    },
    mode: {
        title: 'Listen mode',
        body: 'Never ignores class polls. Always watches every free-text poll in your current Formbar class and sends it to AI when everyone has answered, or sooner when Auto-end is on. With [Con] tag only watches text polls whose question starts with [Con], so you can run ordinary polls without triggering Consensus.'
    },
    autoend: {
        title: 'Auto-end',
        body: 'When at least X% of the class has responded, wait Y seconds, then send those responses to AI and start the follow-up poll. Defaults are 80% and 5 seconds. Turn this off if you only want full completion or Send now.'
    },
    force: {
        title: 'Send now',
        body: 'Sends the responses collected so far to AI without waiting for every student. Consensus then starts the follow-up poll in Formbar. If the original poll finishes after you press this, it will not send again.'
    },
    answers: {
        title: 'Generated answers',
        body: 'These are the multiple-choice options Consensus built from student text. The highlighted option is the factual correct answer when the question has one. The same options are started as a Formbar poll: “Which one is the best?”'
    },
    responses: {
        title: 'Student responses',
        body: 'Live text answers from the current matching poll. Names and wording are exactly what students submitted in Formbar. This table stays empty in Never mode, or when the current poll does not match Always / [Con].'
    }
};

const socket = io();
const classLabel = document.getElementById('class-label');
const userName = document.getElementById('user-name');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const startForm = document.getElementById('start-form');
const seedPrompt = document.getElementById('seed-prompt');
const startBtn = document.getElementById('start-btn');
const autoEnabled = document.getElementById('auto-end-enabled');
const autoSeconds = document.getElementById('auto-end-seconds');
const autoPercent = document.getElementById('auto-end-percent');
const autoStatus = document.getElementById('auto-end-status');
const answersEl = document.getElementById('answers');
const responsesEl = document.getElementById('responses');
const pollMeta = document.getElementById('poll-meta');
const forceBtn = document.getElementById('force-send');
const helpDialog = document.getElementById('help-dialog');
const helpTitle = document.getElementById('help-title');
const helpBody = document.getElementById('help-body');

let applyingAutoSettings = false;
let countdownTimer = null;

function setText(el, text, hiddenIfEmpty) {
    el.textContent = text || '';
    if (hiddenIfEmpty) el.hidden = !text;
}

function renderAnswers(answers) {
    if (!answers || !answers.answers || answers.answers.length === 0) {
        answersEl.className = 'answers empty';
        answersEl.textContent = 'Answers will appear here after Consensus sends a poll to AI.';
        return;
    }

    answersEl.className = 'answers';
    answersEl.replaceChildren();
    for (const answer of answers.answers) {
        const item = document.createElement('div');
        const isCorrect = Boolean(answers.correctAnswer) && answer === answers.correctAnswer;
        item.className = isCorrect ? 'answer correct' : 'answer';
        if (isCorrect) {
            const label = document.createElement('div');
            label.className = 'answer-label';
            label.textContent = 'Correct';
            item.appendChild(label);
        }
        const text = document.createElement('div');
        text.textContent = answer;
        item.appendChild(text);
        answersEl.appendChild(item);
    }
}

function renderResponses(rows) {
    responsesEl.replaceChildren();
    if (!rows || rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 2;
        td.className = 'muted';
        td.textContent = 'No matching text poll yet.';
        tr.appendChild(td);
        responsesEl.appendChild(tr);
        return;
    }

    for (const row of rows) {
        const tr = document.createElement('tr');
        const name = document.createElement('td');
        const response = document.createElement('td');
        name.textContent = row.studentName || '';
        response.textContent = row.response || '';
        tr.appendChild(name);
        tr.appendChild(response);
        responsesEl.appendChild(tr);
    }
}

function emitAutoEnd() {
    if (applyingAutoSettings) return;
    socket.emit('setAutoEnd', {
        enabled: autoEnabled.checked,
        seconds: Number(autoSeconds.value),
        percent: Number(autoPercent.value)
    });
}

function clearCountdown() {
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
}

function startCountdown(remainingMs) {
    clearCountdown();
    if (remainingMs == null) {
        autoStatus.textContent = '';
        return;
    }

    let left = Math.max(0, remainingMs);
    const tick = () => {
        const seconds = Math.ceil(left / 1000);
        autoStatus.textContent = `Sending to AI in ${seconds}s…`;
        if (left <= 0) {
            clearCountdown();
            return;
        }
        left -= 250;
    };
    tick();
    countdownTimer = setInterval(tick, 250);
}

function render(state) {
    userName.textContent = state.user || '';
    classLabel.textContent = state.className
        ? state.className
        : (state.classId != null && state.classId !== ''
            ? `Class ${state.classId}`
            : (state.formbarConnected ? 'No class' : 'Connecting to Formbar…'));

    setText(statusEl, state.statusMessage, true);

    document.querySelectorAll('.seg').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === state.mode);
    });

    applyingAutoSettings = true;
    autoEnabled.checked = Boolean(state.autoEndEnabled);
    autoSeconds.value = state.autoEndSeconds != null ? state.autoEndSeconds : 5;
    autoPercent.value = state.autoEndPercent != null ? state.autoEndPercent : 80;
    applyingAutoSettings = false;

    if (state.autoEndArmed && state.autoEndRemainingMs != null) {
        startCountdown(state.autoEndRemainingMs);
    } else {
        clearCountdown();
        autoStatus.textContent = state.autoEndEnabled
            ? `Waits ${state.autoEndSeconds}s after ${state.autoEndPercent}% respond.`
            : 'Auto-end is off.';
    }

    startBtn.disabled = !state.startEnabled;
    startBtn.textContent = state.starting
        ? 'Starting…'
        : 'Start text poll';

    forceBtn.disabled = !state.forceSendEnabled;
    forceBtn.textContent = state.sendingToAi
        ? 'Sending to AI…'
        : 'Send to AI before poll ends';

    if (state.poll && state.poll.matching) {
        pollMeta.textContent = `${state.poll.prompt} · ${state.poll.totalResponses}/${state.poll.totalResponders} responses (${state.poll.percent || 0}%)`;
    } else if (state.poll && state.poll.isFollowUp) {
        const fromPrompt = state.poll.prompt && state.poll.prompt !== 'Which one is the best?'
            ? `From “${state.poll.prompt}”. `
            : '';
        pollMeta.textContent = `${fromPrompt}Follow-up poll is running in Formbar.`;
    } else {
        pollMeta.textContent = '';
    }

    renderAnswers(state.answers);
    renderResponses(state.responses);
}

startForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const prompt = seedPrompt.value.trim();
    if (!prompt) return;
    socket.emit('startQuestion', { prompt });
});

autoEnabled.addEventListener('change', emitAutoEnd);
autoSeconds.addEventListener('change', emitAutoEnd);
autoPercent.addEventListener('change', emitAutoEnd);

document.querySelectorAll('.seg').forEach((btn) => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.seg').forEach((other) => {
            other.classList.toggle('active', other === btn);
        });
        socket.emit('setMode', btn.dataset.mode);
    });
});

forceBtn.addEventListener('click', () => {
    socket.emit('forceSend');
});

document.querySelectorAll('.help').forEach((btn) => {
    btn.addEventListener('click', () => {
        const help = HELP[btn.dataset.help];
        if (!help) return;
        helpTitle.textContent = help.title;
        helpBody.textContent = help.body;
        helpDialog.showModal();
    });
});

socket.on('state', (state) => {
    errorEl.hidden = true;
    render(state);
});

socket.on('appError', ({ message }) => {
    setText(errorEl, message, true);
});
