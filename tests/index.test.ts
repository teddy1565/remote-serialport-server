/* eslint-disable no-undef */
import { namespace_convert_to_serialport_path, serialport_path_validate, RemoteSerialportServer } from "../src/index";

describe("index", () => {
    describe("namespace_convert_to_serialport_path", () => {
        it("should convert socket.io namespace to serial port path correctly", () => {
            expect(namespace_convert_to_serialport_path("/COM1")).toBe("COM1");
            expect(namespace_convert_to_serialport_path("/dev/ttyUSB0")).toBe("/dev/ttyUSB0");
        });
    });

    describe("serialport_path_validate", () => {
        it("should validate serial port path correctly", () => {
            expect(serialport_path_validate("COM1")).toBe(true);
            expect(serialport_path_validate("/dev/ttyUSB0")).toBe(true);
            expect(serialport_path_validate("invalid_path")).toBe(false);
        });
    });

    describe("RemoteSerialportServer", () => {
        it("should create a new instance of RemoteSerialportServer", () => {
            const server = new RemoteSerialportServer();
            expect(server).toBeInstanceOf(RemoteSerialportServer);
        });

        it("should validate serial port path using static method", () => {
            expect(RemoteSerialportServer.serialport_path_validate("COM1")).toBe(true);
            expect(RemoteSerialportServer.serialport_path_validate("invalid_path")).toBe(false);
        });
    });
});
