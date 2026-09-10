const OpenAI = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

async function summarizeResponsesWithChatGPT(textResponses, pollPrompt) {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not set');
    }

    if (!textResponses || textResponses.length === 0) {
        return null;
    }

    const responsesText = textResponses
        .map((item, index) => `${index + 1}. ${item.studentName}: "${item.response}"`)
        .join('\n');

    const prompt = `
            You are converting student free-response answers into multiple-choice poll options.
            
            ORIGINAL QUESTION:
            ${JSON.stringify(pollPrompt)}
            
            RESPONSES:
            ${responsesText}
            
            Follow this procedure exactly.
            
            A. CLASSIFY EVERY RESPONSE
            
            For every student response, decide exactly one of:
            
            VALID:
            The response attempts to answer the original question.
            It may be factually wrong.
            
            BAD:
            The response does not attempt to answer the question, is nonsense in context,
            or is inappropriate for a high-school classroom.
            
            IMPORTANT:
            A wrong answer is VALID.
            Do not correct student answers during classification.
            
            Examples:
            Question: "What is 1+1?"
            "3" = VALID
            "2" = VALID
            "Giraffe" = BAD
            "Go fuck yourself" = BAD
            
            
            B. GROUP VALID RESPONSES
            
            Group VALID responses by meaning.
            
            Two responses belong together ONLY if they communicate the same answer.
            
            Technical vocabulary is meaningful.
            Do not merge answers when changing a technical term changes the claim.
            
            Example:
            "A definition tells Python what the variable is"
            and
            "A definition tells Python what the function is"
            are DIFFERENT groups.
            
            Spelling, grammar, capitalization, and harmless wording differences do not
            make answers different.
            
            Every VALID student response must belong to exactly one group.
            
            
            C. CREATE POLL OPTIONS
            
            Rank groups by number of student responses.
            
            Create one concise poll option for each of the four largest groups.
            
            Use no more than 4 options.
            Do not create filler options.
            Do not create options that no student expressed, except for the factual
            correct answer rule below.
            
            
            D. DETERMINE FACTUAL CORRECTNESS
            
            Determine whether the original question has one objectively correct factual
            answer.
            
            If it does NOT:
            correctAnswer = ""
            correctAnswerListed = false
            
            If it DOES:
            correctAnswer = a concise correct answer.
            
            Then determine whether one of the student-derived poll options already
            represents that correct answer. Equivalent wording counts as the same
            answer. "Two" and "2" are the same. Keep the student's wording.
            Set correctAnswer to that student option. Do not add another form of it.
            
            If yes:
            correctAnswerListed = true
            
            If no:
            correctAnswerListed = false
            Add exactly ONE correct-answer option.
            
            If there are already 4 student-derived options, remove the least-popular
            student group and replace it with the correct answer.
            
            Never generate multiple equivalent versions of the correct answer.
            
            
            E. FINAL VALIDATION
            
            Before returning JSON, verify all of these:
            
            - Every student response appears exactly once in either a VALID group or badAnswers.
            - No factually incorrect but on-topic answer appears in badAnswers.
            - answers contains at most 4 strings.
            - No answer option was invented except the single missing factual correct answer.
            - If a student already gave the correct answer in different wording, do not add a second equivalent option.
            - Different technical concepts were not accidentally merged.
            - badAnswers contains the student's original name and original response exactly.
            - The output is valid JSON.
            
            Return ONLY this JSON structure:
            
            {
              "answers": ["string"],
              "correctAnswer": "string",
              "correctAnswerListed": true,
              "badAnswers": [
                {
                  "studentName": "exact original name",
                  "response": "exact original response"
                }
              ]
            }
            `;

    const completion = await openai.chat.completions.create({
        model: 'gpt-5.6-luna',
        messages: [
            {
                role: 'system',
                content: `
        You are a strict classroom-response classifier.
        Follow the user's algorithm exactly.
        Wrong but relevant answers are valid answers.
        Never silently correct student responses.
        Equivalent wording of the same correct answer is already listed; do not add a duplicate.
        Technical vocabulary distinctions must be preserved.
        Return only the requested JSON object.
        `
            },
            {
                role: 'user',
                content: prompt
            }
        ],
        temperature: 1
    });

    return completion.choices[0].message.content;
}

function extractJson(text) {
    if (!text) return null;

    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    } catch (e) {
        const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced) {
            try {
                return JSON.parse(fenced[1].trim());
            } catch (ignored) {
                // fall through
            }
        }

        const objectMatch = trimmed.match(/\{[\s\S]*\}/);
        if (objectMatch) {
            try {
                return JSON.parse(objectMatch[0]);
            } catch (ignored) {
                // fall through
            }
        }
    }

    return null;
}

function normalizeText(value) {
    return String(value || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function responseMatchesAnswer(response, answer) {
    const left = normalizeText(response);
    const right = normalizeText(answer);
    if (!left || !right) return false;
    return left === right || left.includes(right) || right.includes(left);
}

function sanitizeSummary(parsed, textResponses) {
    const answers = Array.isArray(parsed.answers)
        ? parsed.answers.map((answer) => String(answer).trim()).filter(Boolean)
        : [];
    const correctAnswer = typeof parsed.correctAnswer === 'string' ? parsed.correctAnswer.trim() : '';
    const badAnswers = Array.isArray(parsed.badAnswers)
        ? parsed.badAnswers
            .filter((item) => item && typeof item === 'object')
            .map((item) => ({
                studentName: String(item.studentName || '').trim(),
                response: String(item.response || '').trim()
            }))
            .filter((item) => item.studentName || item.response)
        : [];

    const studentBackedAnswers = answers.filter((answer) =>
        textResponses.some((item) => responseMatchesAnswer(item.response, answer))
    );

    for (const item of textResponses) {
        const alreadyBad = badAnswers.some((bad) =>
            normalizeText(bad.studentName) === normalizeText(item.studentName)
            && normalizeText(bad.response) === normalizeText(item.response)
        );
        const matchesKeptAnswer = studentBackedAnswers.some((answer) => responseMatchesAnswer(item.response, answer));
        if (!alreadyBad && !matchesKeptAnswer) {
            studentBackedAnswers.push(item.response);
        }
    }

    let cleanedAnswers = [...studentBackedAnswers];
    let correctAnswerListed = Boolean(
        correctAnswer && cleanedAnswers.some((answer) => responseMatchesAnswer(answer, correctAnswer))
    );

    if (correctAnswer && !correctAnswerListed) {
        if (cleanedAnswers.length === 0) {
            cleanedAnswers = [correctAnswer];
        } else if (cleanedAnswers.length < 4) {
            cleanedAnswers.push(correctAnswer);
        } else {
            cleanedAnswers[cleanedAnswers.length - 1] = correctAnswer;
        }
    }

    return {
        answers: cleanedAnswers.slice(0, 4),
        correctAnswer,
        correctAnswerListed,
        badAnswers
    };
}

function parseSummary(summary, textResponses) {
    const parsed = extractJson(summary);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }

    return sanitizeSummary(parsed, textResponses);
}

module.exports = {
    summarizeResponsesWithChatGPT,
    parseSummary
};
