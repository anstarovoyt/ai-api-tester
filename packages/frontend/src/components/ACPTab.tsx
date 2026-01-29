import React from 'react';
import ACPTester from './ACPTester';

const ACPTab: React.FC = () => {
  return (
    <div className="p-6">
      <div className="max-w-6xl mx-auto">
        <ACPTester apiUrl="http://localhost:3001/acp" apiKey="" />
      </div>
    </div>
  );
};

export default ACPTab;
