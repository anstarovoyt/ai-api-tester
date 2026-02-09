# Remote Run Server Implementation Guide

This guide explains how third-party agent vendors can implement a remote run server that integrates with IntelliJ IDEA's ACP (Agent Client Protocol) remote execution feature.

## Overview

Remote run allows an agent to execute on a remote server instead of locally on the user's machine. The IDE connects to your server via WebSocket, sends git repository information, and expects changes to be pushed to a branch that can be merged back into the user's working tree.

### Key Flow

1. User configures your remote agent in `~/.jetbrains/acp.json`
2. IDE establishes WebSocket connection to your server
3. IDE sends `session/new` with current git info
4. Your server clones/pulls the repo, does the work, pushes to a new branch
5. Your server responds with target branch info
6. IDE fetches the remote branch automatically and allows user to merge it
