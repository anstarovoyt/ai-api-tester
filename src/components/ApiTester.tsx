import React, { useState, useEffect } from 'react';

interface ApiTesterProps {
  apiUrl: string;
  apiKey: string;
}

const ApiTester: React.FC<ApiTesterProps> = ({ apiUrl, apiKey }) => {
  const [params, setParams] = useState('');
  const [response, setResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiUrlValue, setApiUrlValue] = useState(apiUrl);
  const [apiKeyValue, setApiKeyValue] = useState(apiKey);
  const [selectedMethod, setSelectedMethod] = useState('/v1/models');
  const [showMethodInput, setShowMethodInput] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [defaultModel, setDefaultModel] = useState('qwen/qwen3-coder-30b');

  // Default templates for each OpenAI method
  const defaultTemplates: Record<string, string> = {
    '/v1/chat/completions': '{"model": "gpt-3.5-turbo", "messages": [{"role": "user", "content": "Hello, how can I help you today?"}], "temperature": 1, "max_tokens": 150, "top_p": 1, "frequency_penalty": 0, "presence_penalty": 0}',
    '/v1/completions': '{"model": "gpt-3.5-turbo", "prompt": "Write a short poem about programming", "temperature": 0.7, "max_tokens": 150, "top_p": 1, "frequency_penalty": 0, "presence_penalty": 0}',
    '/v1/embeddings': '{"model": "text-embedding-ada-002", "input": "The food was delicious"}',
    '/v1/images/generations': '{"model": "dall-e-3", "prompt": "A cute robot playing piano", "n": 1, "size": "1024x1024"}',
    '/v1/audio/transcriptions': '{"model": "whisper-1", "file": "audio.mp3", "prompt": "Transcribe this audio"}',
    '/v1/audio/translations': '{"model": "whisper-1", "file": "audio.mp3", "prompt": "Translate this to English"}',
    '/v1/fine-tunes': '{"model": "gpt-3.5-turbo", "training_file": "file-id"}',
    '/v1/models': '',
    '/v1/images/edits': '{"model": "dall-e-2", "prompt": "A cute robot playing piano", "image": "image.png", "mask": "mask.png"}',
    '/v1/images/variations': '{"model": "dall-e-2", "prompt": "A cute robot playing piano", "image": "image.png"}',
    '/v1/audio/speech': '{"model": "tts-1", "input": "Hello world", "voice": "alloy"}',
    '/v1/fine-tunes/abandon': '{"fine_tune_id": "ft-abc123"}',
    '/v1/fine-tunes/list': '',
    '/v1/models/delete': '{"model": "model-id"}',
    '/v1/models/list': '',
    '/v1/models/retrieve': '{"model": "model-id"}',
    '/v1/responses': '{"input": "Hello", "model": "llama3"}'
  };

// Descriptions for each OpenAI method
  const methodDescriptions: Record<string, string> = {
    '/v1/chat/completions': 'Generates chat completions using a language model, supporting conversation-style interactions with multiple messages.<br><br>Request Parameters (JSON):<br><br><span class="font-semibold">model</span>: string (e.g. gpt-3.5-turbo) - The model to use for generation<br><span class="font-semibold">messages</span>: array of message objects - Array of message objects<br>&nbsp;&nbsp;<span class="font-semibold">role</span>: string (user, assistant, or system) - Role of the message sender<br>&nbsp;&nbsp;<span class="font-semibold">content</span>: string - Content of the message<br><span class="font-semibold">temperature</span>: number (0.0 to 2.0) - Controls randomness (0.0 = deterministic, 2.0 = maximum randomness)<br><span class="font-semibold">max_tokens</span>: integer - Maximum number of tokens to generate<br><span class="font-semibold">top_p</span>: number (0.0 to 1.0) - Controls diversity via nucleus sampling<br><span class="font-semibold">frequency_penalty</span>: number (-2.0 to 2.0) - Modifies probability of tokens based on frequency<br><span class="font-semibold">presence_penalty</span>: number (-2.0 to 2.0) - Modifies probability of tokens based on presence<br><span class="font-semibold">stream</span>: boolean - Whether to stream responses',
    '/v1/completions': 'Generates text completions from a given prompt, supporting various text generation tasks.<br><br>Request Parameters (JSON):<br><br><span class="font-semibold">model</span>: string (e.g. gpt-3.5-turbo) - The model to use for generation<br><span class="font-semibold">prompt</span>: string - Text to complete<br><span class="font-semibold">temperature</span>: number (0.0 to 2.0) - Controls randomness (0.0 = deterministic, 2.0 = maximum randomness)<br><span class="font-semibold">max_tokens</span>: integer - Maximum number of tokens to generate<br><span class="font-semibold">top_p</span>: number (0.0 to 1.0) - Controls diversity via nucleus sampling<br><span class="font-semibold">frequency_penalty</span>: number (-2.0 to 2.0) - Modifies probability of tokens based on frequency<br><span class="font-semibold">presence_penalty</span>: number (-2.0 to 2.0) - Modifies probability of tokens based on presence<br><span class="font-semibold">stream</span>: boolean - Whether to stream responses',
    '/v1/embeddings': 'Generates embeddings for input text, converting text into numerical vectors that capture semantic meaning.<br><br>Request Parameters (JSON):<br><br><span class="font-semibold">model</span>: string (e.g. text-embedding-ada-002) - The model to use for generating embeddings<br><span class="font-semibold">input</span>: string - Text to generate embeddings for',
    '/v1/images/generations': 'Generates images from text prompts using image generation models like DALL-E.<br><br>Request Parameters (JSON):<br><br><span class="font-semibold">model</span>: string (e.g. dall-e-3) - The model to use for image generation<br><span class="font-semibold">prompt</span>: string - Text description of the image to generate<br><span class="font-semibold">n</span>: integer (1-10) - Number of images to generate<br><span class="font-semibold">size</span>: string (1024x1024, 1024x1792, or 1792x1024) - Dimensions of the generated image',
    '/v1/audio/transcriptions': 'Transcribes audio files into text using speech recognition models like Whisper.<br><br>Request Parameters (JSON):<br><br><span class="font-semibold">model</span>: string (e.g. whisper-1) - The model to use for transcription<br><span class="font-semibold">file</span>: string - Audio file to transcribe<br><span class="font-semibold">prompt</span>: string - Text to guide the transcription',
    '/v1/audio/translations': 'Translates audio files into text in a different language using speech recognition models like Whisper.<br><br>Request Parameters (JSON):<br><br><span class="font-semibold">model</span>: string (e.g. whisper-1) - The model to use for translation<br><span class="font-semibold">file</span>: string - Audio file to translate<br><span class="font-semibold">prompt</span>: string - Text to guide the translation',
    '/v1/fine-tunes': 'Creates fine-tuned versions of existing models for specific tasks by training on custom datasets.<br><br>Request Parameters (JSON):<br><br><span class="font-semibold">model</span>: string (e.g. gpt-3.5-turbo) - Base model to fine-tune<br><span class="font-semibold">training_file</span>: string - ID of the file containing training data',
    '/v1/models': 'Retrieves a list of available models that can be used with the API.<br><br>No request parameters needed.',
    '/v1/images/edits': 'Creates edited versions of images using image editing models.<br><br>Request Parameters (JSON):<br><br><span class="font-semibold">model</span>: string (e.g. dall-e-2) - The model to use for image editing<br><span class="font-semibold">prompt</span>: string - Text description of the edit to make<br><span class="font-semibold">image</span>: string - Path to the image file to edit<br><span class="font-semibold">mask</span>: string - Path to the mask file (optional)<br><span class="font-semibold">n</span>: integer (1-10) - Number of images to generate<br><span class="font-semibold">size</span>: string (1024x1024, 1024x1792, or 1792x1024) - Dimensions of the generated image',
    '/v1/images/variations': 'Creates variations of images using image variation models.<br><br>Request Parameters (JSON):<br><br><span class="font-semibold">model</span>: string (e.g. dall-e-2) - The model to use for image variation<br><span class="font-semibold">prompt</span>: string - Text description of the variation to make<br><span class="font-semibold">image</span>: string - Path to the image file to vary<br><span class="font-semibold">n</span>: integer (1-10) - Number of images to generate<br><span class="font-semibold">size</span>: string (1024x1024, 1024x1792, or 1792x1024) - Dimensions of the generated image',
    '/v1/audio/speech': 'Generates speech from text using text-to-speech models.<br><br>Request Parameters (JSON):<br><br><span class="font-semibold">model</span>: string (e.g. tts-1) - The model to use for speech generation<br><span class="font-semibold">input</span>: string - Text to convert to speech<br><span class="font-semibold">voice</span>: string (alloy, echo, fable, onyx, nova, or shimmer) - Voice to use for speech<br><span class="font-semibold">response_format</span>: string (mp3, opus, aac, or wav) - Format of the response audio<br><span class="font-semibold">speed</span>: number (0.25 to 4.0) - Speed of the speech (default 1.0)',
    '/v1/fine-tunes/abandon': 'Aborts a fine-tuning job.<br><br>Request Parameters (JSON):<br><br><span class="font-semibold">fine_tune_id</span>: string - ID of the fine-tuning job to abandon',
    '/v1/fine-tunes/list': 'Lists fine-tuning jobs.<br><br>No request parameters needed.',
    '/v1/models/delete': 'Deletes a fine-tuned model.<br><br>Request Parameters (JSON):<br><br><span class="font-semibold">model</span>: string - ID of the model to delete',
    '/v1/models/list': 'Lists all models available.<br><br>No request parameters needed.',
    '/v1/models/retrieve': 'Retrieves information about a specific model.<br><br>Request Parameters (JSON):<br><br><span class="font-semibold">model</span>: string - ID of the model to retrieve',
    '/v1/responses': 'Endpoint for receiving responses from LM Studio server.<br><br>Request Parameters (JSON):<br><br><span class="font-semibold">input</span>: string - Text input to generate response for<br><span class="font-semibold">model</span>: string - Model name to use for generation<br><span class="font-semibold">temperature</span>: number (0.0 to 2.0) - Controls randomness (0.0 = deterministic, 2.0 = maximum randomness)<br><span class="font-semibold">max_tokens</span>: integer - Maximum number of tokens to generate<br><span class="font-semibold">top_p</span>: number (0.0 to 1.0) - Controls diversity via nucleus sampling<br><span class="font-semibold">frequency_penalty</span>: number (-2.0 to 2.0) - Modifies probability of tokens based on frequency<br><span class="font-semibold">presence_penalty</span>: number (-2.0 to 2.0) - Modifies probability of tokens based on presence<br><span class="font-semibold">stream</span>: boolean - Whether to stream responses'
  };

  const openaiMethods = [
     '/v1/chat/completions',
     '/v1/completions',
     '/v1/embeddings',
     '/v1/images/generations',
     '/v1/audio/transcriptions',
     '/v1/audio/translations',
     '/v1/fine-tunes',
     '/v1/models',
     '/v1/images/edits',
     '/v1/images/variations',
     '/v1/audio/speech',
     '/v1/fine-tunes/abandon',
     '/v1/fine-tunes/list',
     '/v1/models/delete',
     '/v1/models/list',
     '/v1/models/retrieve',
      '/v1/responses'
   ];

  const apiUrlOptions = [
    'http://localhost:1234',
    'https://api.openai.com',
    'https://api.anthropic.com',
    'https://api.cohere.ai',
    'https://api.groq.com'
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    console.log('=== API TESTER DEBUG START ===');
    e.preventDefault();
    console.log('Form submitted with:', {
      apiUrlValue,
      apiKeyValue,
      selectedMethod,
      params
    });

    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      console.log('Attempting to send request...');

      // Use the proxy server for local API requests
      const proxyUrl = apiUrlValue.includes('localhost:1234')
        ? `http://localhost:3001/${selectedMethod.startsWith('/') ? selectedMethod : '/' + selectedMethod}`
        : `${apiUrlValue}${selectedMethod.startsWith('/') ? selectedMethod : '/' + selectedMethod}`;

      console.log('Constructed proxy URL:', proxyUrl);

      let res;

      // Handle GET request for /v1/models
      if (selectedMethod === '/v1/models') {
        console.log('Sending GET request...');
        res = await fetch(proxyUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKeyValue}`
          }
        });
      } else {
        // Handle POST requests with proper JSON parsing and validation
        let requestBody = {};
        if (params) {
          try {
            console.log('Parsing JSON params:', params);
            requestBody = JSON.parse(params);
            console.log('Parsed request body:', requestBody);
          } catch (parseError) {
            const errorMsg = `Invalid JSON in parameters: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`;
            console.error('JSON parsing error:', errorMsg);
            setError(errorMsg);
            return;
          }
        } else {
          console.log('No parameters provided, using empty body');
        }

        console.log('Sending POST request with body:', requestBody);
        res = await fetch(proxyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKeyValue}`
          },
          body: JSON.stringify(requestBody)
        });
      }

      console.log('Response received:', {
        status: res.status,
        statusText: res.statusText,
        headers: Array.from(res.headers.entries()).reduce((acc, [key, value]) => {
          acc[key] = value;
          return acc;
        }, {} as Record<string, string>)
      });

      // Check if the response is ok
      if (!res.ok) {
        console.log('Response not OK, getting error details...');
        const errorData = await res.json().catch(() => ({}));
        const errorMessage = errorData.error?.message ||
                          errorData.message ||
                          `HTTP Error: ${res.status} - ${res.statusText}`;

        console.error('API Error:', errorMessage);
        setError(`API Error: ${errorMessage}`);
        return;
      }

      console.log('Response is OK, parsing JSON...');
      const data = await res.json();
      console.log('Parsed response data:', data);
      setResponse(JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Caught exception in handleSubmit:', err);
      if (err instanceof Error) {
        // Provide more detailed error information
        if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
          // Check for CORS error specifically
          if (err.message.includes('CORS') || err.message.includes('Access to fetch')) {
            const corsError = `CORS Error: ${err.message}\n\nThis error occurs because:\n- The API server doesn't allow requests from http://localhost:3001\n- You need to configure CORS on the API server\n- For local development, you might need to run the API server with appropriate CORS headers\n\nFor testing with local APIs:\n1. Make sure your API server allows requests from http://localhost:3001\n2. Or use the proxy server (which is already configured in this app)\n3. Run your API server on port 1234`;
            console.error('CORS Error details:', corsError);
            setError(corsError);
          } else {
            const networkError = `Network Error: ${err.message}\n\nThis could be due to:\n- The API server is not running\n- CORS restrictions\n- Invalid URL format\n- Network connectivity issues`;
            console.error('Network Error details:', networkError);
            setError(networkError);
          }
        } else {
          const requestError = `Request Error: ${err.message}`;
          console.error('Request Error details:', requestError);
          setError(requestError);
        }
      } else {
        const unknownError = 'An unknown error occurred';
        console.error('Unknown Error details:', unknownError);
        setError(unknownError);
      }
    } finally {
      console.log('=== API TESTER DEBUG END ===');
      setLoading(false);
    }
  };

  // Update params when the method changes to use the template with a default model
  useEffect(() => {
    if (defaultTemplates[selectedMethod]) {
      // Replace the model in the template with the default model
      let template = defaultTemplates[selectedMethod];

      // Find and replace the model in the template if it exists
      const modelRegex = /"model":\s*"([^"]*)"/;
      if (modelRegex.test(template)) {
        template = template.replace(modelRegex, `"model": "${defaultModel}"`);
      }

      // Format JSON for better readability
      try {
        const parsed = JSON.parse(template);
        setParams(JSON.stringify(parsed, null, 2));
      } catch (e) {
        setParams(template);
      }
    }
  }, [selectedMethod, defaultModel]);


  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-3xl font-bold text-gray-800 mb-6">OpenAI Compatible API Tester</h1>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-700 mb-4">Configuration</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">API URL</label>
            <div className="flex items-center space-x-2">
              <select
                value={apiUrlValue}
                onChange={(e) => setApiUrlValue(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {apiUrlOptions.map((url) => (
                  <option key={url} value={url}>
                    {url}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setShowUrlInput(!showUrlInput)}
                className="px-3 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500"
              >
                {showUrlInput ? 'Hide' : 'Edit'}
              </button>
            </div>
            {showUrlInput && (
              <input
                type="text"
                value={apiUrlValue}
                onChange={(e) => setApiUrlValue(e.target.value)}
                className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Enter custom API URL"
              />
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">API Key</label>
            <input
              type="password"
              value={apiKeyValue}
              onChange={(e) => setApiKeyValue(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-700 mb-4">Default Model</h2>
        <div className="flex items-center space-x-2">
          <input
            type="text"
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Enter default model name (e.g. gpt-3.5-turbo)"
          />
          <div className="text-sm text-gray-500">
            This model will be used in all generated templates
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-700 mb-4">Test Endpoint</h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">OpenAI Method</label>
            <div className="flex items-center space-x-2">
              <select
                value={selectedMethod}
                onChange={(e) => setSelectedMethod(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {openaiMethods.map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setShowMethodInput(!showMethodInput)}
                className="px-3 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500"
              >
                {showMethodInput ? 'Hide' : 'Edit'}
              </button>
            </div>
            {showMethodInput && (
              <input
                type="text"
                value={selectedMethod}
                onChange={(e) => setSelectedMethod(e.target.value)}
                className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Enter custom method path"
              />
            )}
          </div>

          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">Method Description</label>
            <div className="bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded-md text-xs">
              {methodDescriptions[selectedMethod] ? (
                <div dangerouslySetInnerHTML={{ __html: methodDescriptions[selectedMethod] }} />
              ) : (
                'No description available for this method.'
              )}
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">Request Parameters (JSON)</label>
            <textarea
              value={params}
              onChange={(e) => setParams(e.target.value)}
              placeholder='{"model": "gpt-3.5-turbo", "messages": [{"role": "user", "content": "Hello"}]}'
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 h-48 text-xs"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className={`px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {loading ? 'Sending...' : 'Send Request'}
          </button>
        </form>
      </div>

      {response && (
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-xl font-semibold text-gray-700 mb-4">Response</h2>
          <pre className="bg-gray-100 p-4 rounded-md overflow-auto max-h-96 text-xs">
            {response}
          </pre>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md">
          <p className="font-semibold">Error Details:</p>
          <p>{error}</p>
          {error.includes('CORS') && (
            <div className="mt-2 text-sm">
              <p className="font-medium">Solution:</p>
              <p>To test local APIs, you can:</p>
              <ol className="list-decimal pl-5 mt-1">
                <li>Run your API server with proper CORS headers</li>
                <li>Use the proxy server (already configured in this app)</li>
                <li>Test with public APIs like OpenAI instead</li>
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ApiTester;