## ACP remote server

The architecture should include several blocks (files):

1. Server initialization code (set up web sockets) listen to the message.
2. ACP-agent-related code (also should be encapsulated as much as possible).
3. Git-related code to work with the branches and worktrees. In the upcoming future we plan to use containers to start the work of agent, so it should be generic enough to simply include the function.
4. Session management: we can have several simultaneous started sessions,
     and for the started session we should keep it independent of the connected client.
     The session/load function should be capable of loading the session even if we had a websocket disconnection.
