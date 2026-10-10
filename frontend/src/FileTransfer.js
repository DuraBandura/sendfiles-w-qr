import config from "./Config.js";
import { NEW_ICE_CANDIDATE } from "./Constants.js";

class Client {
  constructor(socket) {
    this.socket = socket;
    this.pendingCandidates = [];

    const configuration = { iceServers: [{ urls: config.STUN_SERVER }] };
    this.connection = new RTCPeerConnection(configuration);
    this.registerIceCandidateListener();
  }

  registerIceCandidateListener() {
    this.connection.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        this.sendMessage({
          type: NEW_ICE_CANDIDATE,
          candidate: event.candidate,
        });
      }
    });
  }

  addIceCandidate(candidate) {
    // кандидат мог прийти раньше, чем установлено remote description
    if (!this.connection.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    this.connection
      .addIceCandidate(candidate)
      .catch((e) => console.error("adding ice candidate", e));
  }

  async flushCandidates() {
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) {
      await this.connection
        .addIceCandidate(candidate)
        .catch((e) => console.error("adding ice candidate", e));
    }
  }

  setRecipientAddress(addr) {
    this.recipientAddr = addr;
  }

  sendMessage(message) {
    const body = {
      action: "SEND_MESSAGE",
      recipient: this.recipientAddr,
      body: JSON.stringify(message),
    };
    const encoded = JSON.stringify(body);
    this.socket.send(encoded);
  }
}

export class Sender extends Client {
  chunkSize = 16 * 1024;

  // onProgress(p) вызывается с числом от 0 до 1
  constructor(socket, contents, onProgress) {
    super(socket);

    this.contents = contents;
    this.onProgress = onProgress;

    this.channel = this.connection.createDataChannel("sendDataChannel");
    this.channel.binaryType = "arraybuffer";

    // "useless" in-line lambdas because otherwise `this` gets overridden in the callback
    this.channel.addEventListener("open", () =>
      this.onSendChannelStateChange(),
    );
    this.channel.addEventListener("close", () =>
      this.onSendChannelStateChange(),
    );
    this.channel.addEventListener("error", (error) =>
      console.error("Error in sendChannel:", error),
    );
  }

  onSendChannelStateChange() {
    const readyState = this.channel.readyState;
    if (readyState === "open") {
      this.sendData();
    }
  }

  async createOffer() {
    try {
      const desc = await this.connection.createOffer();
      await this.connection.setLocalDescription(desc);
      return desc;
    } catch (e) {
      console.error("Failed to create session description: ", e);
    }
  }

  async registerAnswer(desc) {
    await this.connection.setRemoteDescription(desc);
    await this.flushCandidates();
  }

  sendData() {
    let offset = 0;
    const contentLen = this.contents.byteLength;

    // большой буфер, чтобы скорость не упиралась в задержку сети
    const bufferUpTo = 1024 * 1024;

    const fillBuffer = () => {
      while (offset < contentLen && this.channel.bufferedAmount < bufferUpTo) {
        const sliceContents = this.contents.slice(
          offset,
          offset + this.chunkSize,
        );
        this.channel.send(sliceContents);
        offset += sliceContents.byteLength;
      }
    };
    this.channel.bufferedAmountLowThreshold = bufferUpTo / 4;
    this.channel.onbufferedamountlow = fillBuffer;
    fillBuffer();

    // прогресс: отправлено минус то, что ещё стоит в буфере
    const report = (p) => {
      if (this.onProgress) {
        this.onProgress(p);
      }
    };
    report(0);
    const timer = setInterval(() => {
      if (this.channel.readyState !== "open") {
        clearInterval(timer);
        return;
      }
      const sent = Math.max(0, offset - this.channel.bufferedAmount);
      if (offset >= contentLen && this.channel.bufferedAmount === 0) {
        clearInterval(timer);
        report(1);
        return;
      }
      report(Math.min(0.99, sent / contentLen));
    }, 200);
  }
}

export class Receiver extends Client {
  receivedSize = 0;

  constructor(socket, fileSize) {
    super(socket);

    this.receiveBuffer = new Uint8Array(fileSize);

    // this is a funky interface hack that turns the registered-callback interface
    // into an async/await promise interface :(
    this.completionPromise = new Promise((resolve, reject) => {
      this.resolveCompletionPromise = resolve;
    });

    this.fileSize = fileSize;
    this.connection.addEventListener("datachannel", (event) =>
      this.receiveChannelCallback(event),
    );
  }

  async answer(desc) {
    await this.connection.setRemoteDescription(desc);
    await this.flushCandidates();
    try {
      const answer = await this.connection.createAnswer();
      await this.connection.setLocalDescription(answer);
      return answer;
    } catch (e) {
      console.error("Failed to create session description: ", e);
    }
  }

  receiveChannelCallback(event) {
    const receiveChannel = event.channel;
    receiveChannel.binaryType = "arraybuffer";
    receiveChannel.onmessage = (event) => this.onReceiveMessageCallback(event);
    receiveChannel.onopen = () =>
      this.onReceiveChannelStateChange(receiveChannel);
    receiveChannel.onclose = () =>
      this.onReceiveChannelStateChange(receiveChannel);
  }

  onReceiveMessageCallback(event) {
    this.receiveBuffer.set(new Uint8Array(event.data), this.receivedSize);
    this.receivedSize += event.data.byteLength;

    console.log(`Received progress: ${this.receivedSize}`);

    // we are assuming that our signaling protocol told
    // about the expected file size (and name, hash, etc).
    if (this.receivedSize === this.fileSize) {
      this.resolveCompletionPromise(this.receiveBuffer);
      console.log("TODO close channels");
    }
  }

  async onReceiveChannelStateChange(channel) {
    console.log(`channel readyState: ${channel.readyState}`);
  }
}
