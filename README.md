# Consensus Poll App with ChatGPT Integration

This app connects to FormBar and automatically summarizes student text responses using ChatGPT when a poll is completed.

## Features

- Connects to FormBar via Socket.IO
- Monitors poll completion (when `totalResponses` equals `totalResponders`)
- Collects all student text responses
- Sends responses to ChatGPT for summarization
- Displays the summary in the console

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set up your OpenAI API key:
   - Get an API key from [OpenAI](https://platform.openai.com/api-keys)
   - Set the environment variable:
     ```bash
     set OPENAI_API_KEY=your-api-key-here
     ```
   - Or replace `'your-openai-api-key-here'` in `app.js` with your actual API key

3. Run the app:
   ```bash
   node app.js
   ```

## How it Works

1. The app connects to FormBar and listens for class updates
2. When a poll is complete (all students have responded), it:
   - Collects all student text responses from the `pollRes.textRes` field
   - Formats them with student names
   - Sends them to ChatGPT with the prompt "summarize these responses"
   - Displays the summary in the console

## Testing

To test with the sample data, uncomment the last line in `app.js`:
```javascript
testWithSampleData();
```

This will run the summarization with the sample data in `data.js`.

## Sample Output

When a poll is complete, you'll see output like:
```
Poll is complete! Collecting and summarizing responses...
Found 1 text responses
Sending responses to ChatGPT for summarization...
Responses: 1. Chris Guy: "This is my answer..."

=== CHATGPT SUMMARY ===
The student provided a response stating "This is my answer..." which appears to be a placeholder or test response.
======================
```
