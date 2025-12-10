## Alimad Websocket

(Deployed on trial version of Railway.app)

**index.js** Server (Port 8392)

**madsocket.js** Client /

To run server:

```
npm i
node index.js
```

There are two routes of this socket

### /
This is the main socket. It has a channel based subscription system. Multiple users can connect to the same channel and when one sends data, others instantly see it. You can subscribe multiple channels.

Read index.js to see how it works, use madsocket.js to make a quick client.

This socket is well used in https://chat.alimad.co

### /socket
This is the socket route for exposing ../activity on the main site. Any activity uploaded from my computer goes to this socket, to which clients can subscribe. It had to be saparate from / because it has an authentication system.
