import React from 'react';
import MCPTester from './MCPTester';

const MCPTab: React.FC = () => {
  return (
    <div className="p-6">
      <div className="max-w-6xl mx-auto">
        <MCPTester apiUrl="http://localhost:4040" apiKey="" />
      </div>
    </div>
  );
};

export default MCPTab;
