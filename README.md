# Remote-Serialport

## Intro

This is a repository for remote proxying of serial ports.

It is a simple server-client architecture where the server is connected to the serial port and the client connects to the server to read and write to the serial port.

This Project is divided into three parts:

1. Server
   - Control Host Physical Serial Port, and virtualize it to the network or IPC.
     - Milestone
       - [ ] Web Socket
       - [ ] Nodejs IPC
       - [ ] Electron utility IPC
2. Client
   - Connect to the server and read and write to the serial port.
     - Milestone
       - [ ] Web Socket
       - [ ] Nodejs IPC
       - [ ] Electron utility IPC
3. Types
   - Common types used in both server and client.

## Features

- [ ] Remote Serial Port Protocol ▶
  - [ ] Web Socket  ▶
    - [x] Connect To Socket Server
    - [x] Socket NameSpace Parser for Serial Port
  - [ ] Inter Process Communication  ○
- [ ] Read from serial port ▶
  - [ ] Read With Parser
    - [ ] ByteLengthParser
    - [ ] CCTalkParser
    - [ ] InterByteTimeoutParser
    - [ ] PacketLengthParser
    - [ ] ReadlineParser
    - [ ] ReadyParser
    - [ ] RegexParser
    - [ ] SlipEncoder
    - [ ] SpacePacketParser
- [ ] Write to serial port
  - [ ] Web Socket
    - [ ] Write to Serial Port
  - [ ] Inter Process Communication
    - [ ] Write to Serial Port
- [ ] Others
  - [ ] Security
    - [ ] Web Socket Security
      - [ ] Connect to server with authentication
      - [ ] Connect to server with encryption
    - [ ] Inter Process Communication Security
      - [ ] Message Encryption
      - [ ] Memory Protection
      - [ ] Message Authentication
  
## Usage

### Server

```typescript
// develop simple document
import { RemoteSerialportServer } from "../index";
const server_options = {
    cors: {
        allowedHeaders: ["*"],
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE"]
    }
};

const server = new RemoteSerialportServer(server_options, 17991);
server.listen();

server.of().on("connection", (socket) => {
    if (RemoteSerialportServer.serialport_path_validate(socket.serialport_path)) {
        console.log(`Serial Port Path: ${socket.serialport_path} is Valid`);
    }
});


```
