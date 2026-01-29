import React, { useState } from 'react';

const A2ATab: React.FC = () => {
  const [endpoint, setEndpoint] = useState('http://localhost:3001');

  return (
    <div className="p-6">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-800 mb-6">A2A (Agent-to-Agent) Protocol Tester</h1>

        {/* Configuration Section */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-700 mb-4">Configuration</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">A2A Server Endpoint</label>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="http://localhost:3001"
              />
            </div>
            <div className="flex items-end">
              <span className="inline-flex items-center px-3 py-2 rounded-full text-sm font-medium bg-gray-100 text-gray-600">
                <span className="w-2 h-2 rounded-full mr-2 bg-gray-400"></span>
                Coming Soon
              </span>
            </div>
          </div>
        </div>

        {/* Placeholder Content */}
        <div className="bg-white rounded-lg shadow-md p-6">
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <svg className="w-20 h-20 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <h3 className="text-xl font-semibold text-gray-600 mb-2">A2A Protocol Support Coming Soon</h3>
            <p className="text-sm text-gray-500 text-center max-w-md">
              The Agent-to-Agent (A2A) protocol enables direct communication between AI agents.
              This feature is under development.
            </p>
            <div className="mt-6 p-4 bg-blue-50 rounded-lg border border-blue-200 max-w-lg">
              <h4 className="text-sm font-semibold text-blue-800 mb-2">Planned Features:</h4>
              <ul className="text-sm text-blue-700 space-y-1">
                <li>• Agent discovery and registration</li>
                <li>• Task delegation between agents</li>
                <li>• Agent capability negotiation</li>
                <li>• Message routing and delivery</li>
                <li>• Agent authentication</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default A2ATab;
