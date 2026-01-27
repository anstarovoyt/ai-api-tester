import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import OpenAIAPITab from './components/OpenAIAPITab';
import MCPTab from './components/MCPTab';
import A2ATab from './components/A2ATab';
import ACPTab from './components/ACPTab';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState('openai');

  const pathToTab = (path: string) => {
    const normalized = path.replace(/\/+$/, '').toLowerCase();
    if (normalized.endsWith('/mcp')) return 'mcp';
    if (normalized.endsWith('/a2a')) return 'a2a';
    if (normalized.endsWith('/acp')) return 'acp';
    if (normalized.endsWith('/openai') || normalized.endsWith('/openaiapi')) return 'openai';
    return 'openai';
  };

  const tabToPath = (tab: string) => {
    switch (tab) {
      case 'mcp':
        return '/mcp';
      case 'a2a':
        return '/a2a';
      case 'acp':
        return '/acp';
      case 'openai':
      default:
        return '/openaiapi';
    }
  };

  useEffect(() => {
    const initialTab = pathToTab(window.location.pathname);
    setActiveTab(initialTab);
    const handlePopState = () => {
      setActiveTab(pathToTab(window.location.pathname));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    const nextPath = tabToPath(tab);
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, '', nextPath);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex space-x-8">
            <button
              onClick={() => handleTabChange('openai')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'openai'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              OpenAI API
            </button>
            <button
              onClick={() => handleTabChange('mcp')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'mcp'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              MCP
            </button>
            <button
              onClick={() => handleTabChange('a2a')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'a2a'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              A2A
            </button>
            <button
              onClick={() => handleTabChange('acp')}
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
