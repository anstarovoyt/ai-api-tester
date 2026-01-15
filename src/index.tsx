import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import OpenAIAPITab from './components/OpenAIAPITab';
import MCPTab from './components/MCPTab';
import A2ATab from './components/A2ATab';
import ACPTab from './components/ACPTab';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState('openai');

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex space-x-8">
            <button
              onClick={() => setActiveTab('openai')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'openai'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              OpenAI API
            </button>
            <button
              onClick={() => setActiveTab('mcp')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'mcp'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              MCP
            </button>
            <button
              onClick={() => setActiveTab('a2a')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'a2a'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              A2A
            </button>
            <button
              onClick={() => setActiveTab('acp')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'acp'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              ACP
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {activeTab === 'openai' && <OpenAIAPITab />}
        {activeTab === 'mcp' && <MCPTab />}
        {activeTab === 'a2a' && <A2ATab />}
        {activeTab === 'acp' && <ACPTab />}
      </div>
    </div>
  );
};

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);