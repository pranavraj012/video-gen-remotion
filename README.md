# Video Generation Module

This module dynamically generates React-based video animations using Google's generative models, resolves Remotion documentation via the Model Context Protocol (MCP), and securely renders the final MP4 utilizing an E2B cloud sandbox environment.

## Architecture

1. **LLM Orchestration**: Uses Google's generative AI (with local Ollama as a fallback configuration) to generate a valid Remotion React component.
2. **Model Context Protocol (MCP)**: Connects to the official `@remotion/mcp` Server to allow the LLM to search and read up-to-date Remotion documentation iteratively if it lacks context.
3. **Secure Rendering (E2B Sandbox)**: 
   - Spawns a pre-configured cloud sandbox instance (`remotion-renderer-v1`).
   - Mounts the generated React code (`MyVideo.tsx`).
   - Starts an internal Express server to bundle and render the Remotion composition.
4. **Asynchronous Polling**: Sends a POST request to the remote sandbox's Express server, polls the render progress, and downloads the final `.mp4` file.

## Prerequisites

- Node.js (v18 or higher)
- A Google API Key (and/or Ollama running locally for fallback)
- An E2B API Key for remote sandboxed execution

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file in the root directory and add your API keys:
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   E2B_API_KEY=your_e2b_api_key_here
   ```

## Usage

To generate and render a video, run the main orchestration script:

```bash
node app.js
```

The script will:
- Connect to the MCP server.
- Prompt the LLM to generate the video component.
- Boot the remote sandbox.
- Poll the rendering endpoint.
- Save the result locally as `out_video.mp4`.
