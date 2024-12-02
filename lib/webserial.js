/* global SerialPort, ParityType, FlowControlType */
/**
 * Wrapper class around Webserial API to communicate with the serial device.
 * @param {typeof import("w3c-web-serial").SerialPort} device - Requested device prompted by the browser.
 *
 * ```
 * const port = await navigator.serial.requestPort();
 * ```
 */
class Transport {
    constructor(device, tracing = false, enableSlipReader = true) {
        this.device = device;
        this.tracing = tracing;
        this.slipReaderEnabled = false;
        this.leftOver = new Uint8Array(0);
        this.baudrate = 0;
        this.traceLog = "";
        this.lastTraceTime = Date.now();
        this._DTR_state = false;
        this.slipReaderEnabled = enableSlipReader;
    }
    /**
     * Request the serial device vendor ID and Product ID as string.
     * @returns {string} Return the device VendorID and ProductID from SerialPortInfo as formatted string.
     */
    getInfo() {
        if ('serial' in navigator) {
            const info = this.device.getInfo();
            return info.usbVendorId && info.usbProductId
                ? `WebSerial VendorID 0x${info.usbVendorId.toString(16)} ProductID 0x${info.usbProductId.toString(16)}`
                : "";
        }else if ('usb' in navigator) {
            // WebUSB
            return `WebUSB VendorID 0x${this.device.vendorId.toString(16)} ProductID 0x${this.device.productId.toString(16)}`;
        }
    }
    /**
     * Request the serial device product id from SerialPortInfo.
     * @returns {number | undefined} Return the product ID.
     */
    getPid() {
        if ('serial' in navigator) {
            return this.device.getInfo().usbProductId;
        }else if ('usb' in navigator) {
            console.log('this.device.productId: ',this.device.productId);
            return this.device.productId;
        }
    }
    /**
     * Format received or sent data for tracing output.
     * @param {string} message Message to format as trace line.
     */
    trace(message) {
        const delta = Date.now() - this.lastTraceTime;
        const prefix = `TRACE ${delta.toFixed(3)}`;
        const traceMessage = `${prefix} ${message}`;
        console.log(traceMessage);
        this.traceLog += traceMessage + "\n";
    }
    async returnTrace() {
        try {
            await navigator.clipboard.writeText(this.traceLog);
            console.log("Text copied to clipboard!");
        }
        catch (err) {
            console.error("Failed to copy text:", err);
        }
    }
    hexify(s) {
        return Array.from(s)
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("")
            .padEnd(16, " ");
    }
    hexConvert(uint8Array, autoSplit = true) {
        if (autoSplit && uint8Array.length > 16) {
            let result = "";
            let s = uint8Array;
            while (s.length > 0) {
                const line = s.slice(0, 16);
                const asciiLine = String.fromCharCode(...line)
                    .split("")
                    .map((c) => (c === " " || (c >= " " && c <= "~" && c !== "  ") ? c : "."))
                    .join("");
                s = s.slice(16);
                result += `\n    ${this.hexify(line.slice(0, 8))} ${this.hexify(line.slice(8))} | ${asciiLine}`;
            }
            return result;
        }
        else {
            return this.hexify(uint8Array);
        }
    }
    /**
     * Format data packet using the Serial Line Internet Protocol (SLIP).
     * @param {Uint8Array} data Binary unsigned 8 bit array data to format.
     * @returns {Uint8Array} Formatted unsigned 8 bit data array.
     */
    slipWriter(data) {
        const outData = [];
        outData.push(0xc0);
        for (let i = 0; i < data.length; i++) {
            if (data[i] === 0xdb) {
                outData.push(0xdb, 0xdd);
            }
            else if (data[i] === 0xc0) {
                outData.push(0xdb, 0xdc);
            }
            else {
                outData.push(data[i]);
            }
        }
        outData.push(0xc0);
        return new Uint8Array(outData);
    }
    /**
     * Write binary data to device using the WebSerial device writable stream.
     * @param {Uint8Array} data 8 bit unsigned data array to write to device.
     */
    async write(data) {
        const outData = this.slipWriter(data);

        if ('serial' in navigator) {
            if (this.device.writable) {
                const writer = this.device.writable.getWriter();
                if (this.tracing) {
                    console.log("Write bytes");
                    this.trace(`Write ${outData.length} bytes: ${this.hexConvert(outData)}`);
                }
                await writer.write(outData);
                writer.releaseLock();
            }
        }else if ('usb' in navigator) {
            try {
                const endpointNumber = 2; // 엔드포인트 번호
                const chunkSize = 128; // 청크 사이즈

                let offset = 0;
                while (offset < outData.length) {
                    const chunk = outData.slice(offset, offset + chunkSize);
                    await this.device.transferOut(endpointNumber, chunk);
                    offset += chunkSize;
                }

                if (this.tracing) {
                    console.log("Write bytes");
                    this.trace(`Write ${outData.length} bytes: ${this.hexConvert(outData)}`);
                }
            } catch (error) {
                console.error("Write operation error:", error.message);
                throw new Error(`Write operation failed: ${error.message}`);
            }
        }
    }
    /**
     * Concatenate buffer2 to buffer1 and return the resulting ArrayBuffer.
     * @param {ArrayBuffer} buffer1 First buffer to concatenate.
     * @param {ArrayBuffer} buffer2 Second buffer to concatenate.
     * @returns {ArrayBuffer} Result Array buffer.
     */
    _appendBuffer(buffer1, buffer2) {
        const tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
        tmp.set(new Uint8Array(buffer1), 0);
        tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
        return tmp.buffer;
    }
    /**
     * Take a data array and return the first well formed packet after
     * replacing the escape sequence. Reads at least 8 bytes.
     * @param {Uint8Array} data Unsigned 8 bit array from the device read stream.
     * @returns {Uint8Array} Formatted packet using SLIP escape sequences.
     */
    slipReader(data) {
        let i = 0;
        let dataStart = 0, dataEnd = 0;
        let state = "init";
        while (i < data.length) {
            if (state === "init" && data[i] == 0xc0) {
                dataStart = i + 1;
                state = "valid_data";
                i++;
                continue;
            }
            if (state === "valid_data" && data[i] == 0xc0) {
                dataEnd = i - 1;
                state = "packet_complete";
                break;
            }
            i++;
        }
        if (state !== "packet_complete") {
            this.leftOver = data;
            return new Uint8Array(0);
        }
        this.leftOver = data.slice(dataEnd + 2);
        const tempPkt = new Uint8Array(dataEnd - dataStart + 1);
        let j = 0;
        for (i = dataStart; i <= dataEnd; i++, j++) {
            if (data[i] === 0xdb && data[i + 1] === 0xdc) {
                tempPkt[j] = 0xc0;
                i++;
                continue;
            }
            if (data[i] === 0xdb && data[i + 1] === 0xdd) {
                tempPkt[j] = 0xdb;
                i++;
                continue;
            }
            tempPkt[j] = data[i];
        }
        const packet = tempPkt.slice(0, j); /* Remove unused bytes due to escape seq */
        return packet;
    }
    /**
     * Read from serial device using the device ReadableStream.
     * @param {number} timeout Read timeout number
     * @param {number} minData Minimum packet array length
     * @returns {Uint8Array} 8 bit unsigned data array read from device.
     */
    async read(timeout = 0, minData = 12) {
        try{
            let t;
            let packet = this.leftOver;
            this.leftOver = new Uint8Array(0);
       
            if (this.slipReaderEnabled) {
                const valFinal = this.slipReader(packet);
                if (valFinal.length > 0) {
                    return valFinal;
                }
                packet = this.leftOver;
                this.leftOver = new Uint8Array(0);
            }
       
            if (this.device.readable == null && !this.device.transferIn) {
                return this.leftOver;
            }
       
            if (this.device.readable) {
                // WebSerial
                this.reader = this.device.readable.getReader();
                try {
                    if (timeout > 0) {
                        t = setTimeout(() => {
                            if (this.reader) {
                                this.reader.cancel();
                            }
                        }, timeout);
                    }
                    do {
                        const { value, done } = await this.reader.read();
                        if (done) {
                            this.leftOver = packet;
                            throw new Error("Timeout");
                        }
                        const p = new Uint8Array(this._appendBuffer(packet.buffer, value.buffer));
                        packet = p;
                    } while (packet.length < minData);
                } finally {
                    if (timeout > 0) {
                        clearTimeout(t);
                    }
                    this.reader.releaseLock();
                }
            } else if (this.device.transferIn) {
                try {
                    const usbData = await this.device.transferIn(2, 128);
                    // const value = new Uint8Array(usbData.data.buffer);

                    const p = new Uint8Array(this._appendBuffer(packet.buffer, usbData.data.buffer));
                    packet = p;
                }catch (e) {
                    console.log("this.device.transferIn error: " + e);
                }
            }
       
            if (this.tracing) {
                console.log("Read bytes");
                this.trace(`Read ${packet.length} bytes: ${this.hexConvert(packet)}`);
            }
       
            if (this.slipReaderEnabled) {
                const slipReaderResult = this.slipReader(packet);
                if (this.tracing) {
                    console.log("Slip reader results");
                    this.trace(`Read ${slipReaderResult.length} bytes: ${this.hexConvert(slipReaderResult)}`);
                }
                return slipReaderResult;
            }
            return packet;
        }
        catch(e)
        {
            console.log("read error: ", e);
        }
    }
    /**
     * Read from serial device without slip formatting.
     * @param {number} timeout Read timeout in milliseconds (ms)
     * @returns {Uint8Array} 8 bit unsigned data array read from device.
     */
    async rawRead(timeout = 0) {
        try{
            if (this.leftOver.length != 0) {
                const p = this.leftOver;
                this.leftOver = new Uint8Array(0);
                return p;
            }
            if ("serial" in navigator){
                if (!this.device.readable) {
                    return this.leftOver;
                }
                this.reader = this.device.readable.getReader();
                let t;
                try {
                    if (timeout > 0) {
                        t = setTimeout(() => {
                            if (this.reader) {
                                this.reader.cancel();
                            }
                        }, timeout);
                    }
                    const { value, done } = await this.reader.read();
                    if (done) {
                        return value;
                    }
                    if (this.tracing) {
                        console.log("Raw Read bytes");
                        this.trace(`Read ${value.length} bytes: ${this.hexConvert(value)}`);
                    }
                    return value;
                }
                finally {
                    if (timeout > 0) {
                        clearTimeout(t);
                    }
                    this.reader.releaseLock();
                }
            }else if ("usb" in navigator && this.device.transferIn) {
                const endpointNumber = 2; // 엔드포인트 번호
                let t;
                try {
                    if (timeout > 0) {
                        t = setTimeout(() => {
                            throw new Error("Timeout");
                        }, timeout);
                    }
                    const usbData = await this.device.transferIn(
                        endpointNumber,
                        128
                    );
                    if (timeout > 0) {
                        clearTimeout(t);
                    }
                    return new Uint8Array(usbData.data.buffer);
                } catch (e) {
                    if (timeout > 0) {
                        clearTimeout(t);
                    }
                    throw e;
                }
            }
            return this.leftOver;
        } catch (error) {
            error("rawRead error: " + error);
        }
    }
    /**
     * Send the RequestToSend (RTS) signal to given state
     * # True for EN=LOW, chip in reset and False EN=HIGH, chip out of reset
     * @param {boolean} state Boolean state to set the signal
     */
    async setRTS(state) {
        if ('serial' in navigator) {
            await this.device.setSignals({ requestToSend: state });
            // # Work-around for adapters on Windows using the usbser.sys driver:
            // # generate a dummy change to DTR so that the set-control-line-state
            // # request is sent with the updated RTS state and the same DTR state
            // Referenced to esptool.py
            await this.setDTR(this._DTR_state);
        }else if ('usb' in navigator) {
            const value = state ? 0x00 : 0x40;
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0xa4,
                value: value,
                index: 0x00
            });
        }
    }
    /**
     * Send the dataTerminalReady (DTS) signal to given state
     * # True for IO0=LOW, chip in reset and False IO0=HIGH
     * @param {boolean} state Boolean state to set the signal
     */
    async setDTR(state) {
        this._DTR_state = state;
        if ('serial' in navigator) {
            await this.device.setSignals({ dataTerminalReady: state });
        } else if ('usb' in navigator) {
            const value = state ? 0x00 : 0x20;
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0xa4,
                value: value,
                index: 0x00
            });
        }
    }
    /**
     * Connect to serial device using the Webserial open method.
     * @param {number} baud Number baud rate for serial connection.
     * @param {typeof import("w3c-web-serial").SerialOptions} serialOptions Serial Options for WebUSB SerialPort class.
     */
    async connect(baud = 115200, serialOptions = {}) {
        if ('serial' in navigator) {
            await this.device.open({
                baudRate: baud,
                dataBits: serialOptions === null || serialOptions === void 0 ? void 0 : serialOptions.dataBits,
                stopBits: serialOptions === null || serialOptions === void 0 ? void 0 : serialOptions.stopBits,
                bufferSize: serialOptions === null || serialOptions === void 0 ? void 0 : serialOptions.bufferSize,
                parity: serialOptions === null || serialOptions === void 0 ? void 0 : serialOptions.parity,
                flowControl: serialOptions === null || serialOptions === void 0 ? void 0 : serialOptions.flowControl,
            });
        }else if ('usb' in navigator) {
            await this.device.open();
            await this.device.selectConfiguration(1);
            await this.device.claimInterface(0);

            // Set the baud rate
            await this.setBaudRate(baud);
        }
        this.baudrate = baud;
        this.leftOver = new Uint8Array(0);
    }

    async setBaudRate(baudRate) {
        const baudRateSetting = this.getBaudRateSetting(baudRate);
        await this.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x9a, // CH340에서 사용하는 명령 코드
            value: 0x1312,
            index: baudRateSetting.valueA,
        });
        await this.sleep(100);
        await this.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x9a,
            value: 0x0f2c,
            index: baudRateSetting.valueB,
        });
        await this.sleep(100);
    }

    /**
     * Calculate the baud rate setting for the device.
     * @param {number} baudRate Desired baud rate.
     * @returns {object} Baud rate setting values.
     */
    getBaudRateSetting(baudRate) {
        const CH341_BAUDBASE_FACTOR = 1532620800;
        const CH341_BAUDBASE_DIVMAX = 3;

        let factor = Math.floor(CH341_BAUDBASE_FACTOR / baudRate);
        let divisor = CH341_BAUDBASE_DIVMAX;

        while (factor > 0xfff0 && divisor > 0) {
            factor >>= 3;
            divisor--;
        }

        if (factor > 0xfff0) {
            throw new Error("Baud rate setting is too high");
        }

        factor = 0x10000 - factor;
        const valueA = (factor & 0xff00) | divisor;
        const valueB = factor & 0xff;

        return { valueA, valueB };
    }


    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /**
     * Wait for a given timeout ms for serial device unlock.
     * @param {number} timeout Timeout time in milliseconds (ms) to sleep
     */
    async waitForUnlock(timeout) {
        while ((this.device.readable && this.device.readable.locked) ||
            (this.device.writable && this.device.writable.locked)) {
            await this.sleep(timeout);
        }
    }
    /**
     * Disconnect from serial device by running SerialPort.close() after streams unlock.
     */
    async disconnect() {
        var _a, _b;
        if ((_a = this.device.readable) === null || _a === void 0 ? void 0 : _a.locked) {
            await ((_b = this.reader) === null || _b === void 0 ? void 0 : _b.cancel());
        }
        await this.waitForUnlock(400);
        this.reader = undefined;
        await this.device.close();
    }
}
export { Transport };
