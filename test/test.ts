import { RemoteSerialportServer } from "../src/index";

const server_options = {
    cors: {
        allowedHeaders: ["*"],
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE"]
    }
};

const server = new RemoteSerialportServer(server_options, 17991);
server.start();
