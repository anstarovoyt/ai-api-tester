## ACP Remote Server

The architecture should include several blocks (files):

1. **Server initialization code** - Set up web sockets and listen to messages
2. **ACP-agent-related code** - Should be encapsulated as much as possible
3. **Git-related code** - Work with branches and worktrees (should be generic enough for containers)
4. **Session management** - Support multiple simultaneous sessions with independent session state
