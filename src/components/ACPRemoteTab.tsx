import React from 'react';
import ACPRemoteTester from './ACPRemoteTester';

const ACPRemoteTab: React.FC = () => {
  return (
    <div className="p-6">
      <div className="max-w-6xl mx-auto">
        <ACPRemoteTester apiUrl="ws://localhost:3001/acp" apiKey="" />
      </div>
    </div>
  );
};

export default ACPRemoteTab;
