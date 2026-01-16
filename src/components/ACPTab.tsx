import React, { useState } from 'react';

const ACPTab: React.FC = () => {
  const [endpoint, setEndpoint] = useState('http://localhost:1234');

  return (
    <div className="p-6">
      <div className="bg-white rounded-lg shadow-md p-6">
        <h2 className="text-xl font-semibold text-gray-700 mb-4">OpenAI Compatible API Tester</h2>
        <div className="grid grid-cols-1 md:grid-cols-1 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">Endpoint</label>
            <input
              type="text"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter ACP endpoint URL"
            />
          </div>
        </div>

        <div className="mt-6">
          <h2 className="text-xl font-semibold text-gray-700 mb-4">Test Endpoint</h2>
          <div className="bg-gray-100 p-4 rounded-md">
            <p className="text-gray-600">ACP API tester placeholder - Configure endpoint above</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ACPTab;