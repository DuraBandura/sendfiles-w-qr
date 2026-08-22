import React, { useState } from "react";
import config from "./Config";
import {
  NEW_ANSWER,
  NEW_OFFER,
  NEW_RECIPIENT,
  NEW_ICE_CANDIDATE,
} from "./Constants";
import { genKey, encryptMessage, exportKeyAsBase64 } from "./Crypto";
import { readFile } from "./File";
import { Sender } from "./FileTransfer";
import ClipboardButton from "./ClipboardButton";
import { QRCodeSVG } from "qrcode.react";
import "./SendApp.css";

// Словарь переводов
const translations = {
  ru: {
    howItWorks: "Как это работает",
    selectFile: "Выберите файл для передачи",
    fileNote: "Обратите внимание: файл не будет загружен на сервер. Когда вы нажмете кнопку отправки, будет создана уникальная ссылка, позволяющая получателю скачать файл напрямую из вашего браузера.",
    choosePassword: "Придумайте пароль",
    passwordNote: "Пароль будет использован для шифрования вашего файла. Вам нужно будет передать его получателю.",
    generateLink: "Создать ссылку",
    generateNote: "Нажатие кнопки \"Создать\" зашифрует ваш файл в вашем браузере с использованием указанного пароля. Затем будет создана уникальная ссылка, которой вы можете поделиться для передачи зашифрованного файла напрямую из вашего браузера.",
    generate: "Создать",
    share: "Поделиться",
    keepWindowOpen: "Вам нужно оставить это окно открытым до тех пор, пока файл не будет полностью скопирован в браузер получателя.",
    sendLink: "Отправьте следующую ссылку получателю вместе с вашим паролем:",
    qrCodeLabel: "QR-код для скачивания",
    hideSettings: "Скрыть настройки",
    settings: "⚙️ Настройки",
    sizePixels: "Размер (пиксели):",
    errorCorrection: "Коррекция ошибок:",
    low: "Низкая (7%)",
    medium: "Средняя (15%)",
    quartile: "Квартильная (25%)",
    high: "Высокая (30%)",
    langSwitch: "English"
  },
  en: {
    howItWorks: "How it works",
    selectFile: "Select a file to transfer",
    fileNote: "Note the file will not be uploaded to a server. When you click submit, a unique link will be generated allowing the receiver to download the file directly from your browser.",
    choosePassword: "Choose a password",
    passwordNote: "The password will be used to encrypt your file. You will need to share it with the recipient.",
    generateLink: "Generate link",
    generateNote: "Clicking \"Generate\" will encrypt your file in your browser using the provided password. It'll then generate a unique link that you can share for users to transfer the encrypted file directly from your browser.",
    generate: "Generate",
    share: "Share",
    keepWindowOpen: "You'll need to leave this window open until the file is completely copied to their browser.",
    sendLink: "Send the following link to the recipient, along with your password:",
    qrCodeLabel: "QR Code for download link",
    hideSettings: "Hide settings",
    settings: "⚙️ Settings",
    sizePixels: "Size (pixels):",
    errorCorrection: "Error correction:",
    low: "Low (7%)",
    medium: "Medium (15%)",
    quartile: "Quartile (25%)",
    high: "High (30%)",
    langSwitch: "Русский"
  }
};

function getReceiverLink(id) {
  // Генерируем ссылку на оригинальном домене sendfiles.dev
  return `https://sendfiles.dev/receive/${id}`;
}

function SendApp() {
  const [fileDetails, setFileDetails] = useState();
  const [password, setPassword] = useState("");
  const [receiveLink, setReceiveLink] = useState();
  const [passwordPlaceholder] = useState(
    Math.random() < 0.5 ? "hunter2" : "correct-horse-battery-staple",
  );
  const [formErrors, setFormErrors] = useState();
  const [qrSize, setQrSize] = useState(512); // Начальный размер 512px
  const [qrLevel, setQrLevel] = useState("H"); // Высокая коррекция ошибок по умолчанию
  const [showQRSettings, setShowQRSettings] = useState(false);
  const [lang, setLang] = useState('ru'); // Русский язык по умолчанию
  
  const t = translations[lang];

  const handleLangSwitch = () => {
    setLang(prev => prev === 'ru' ? 'en' : 'ru');
  };

  // save files when selected
  const onFileSelected = (e) => {
    const file = e.target.files[0];
    if (!file) {
      console.log("No file chosen");
      return;
    }

    setFileDetails(file);
    setFormErrors();
  };

  // form validation
  const validateForm = () => {
    let newErrors = {};

    if (!fileDetails) {
      newErrors.file_input = "At least one file must be selected";
    } else if (fileDetails.size > 100 * 1024 * 1024) {
      // https://stackoverflow.com/a/32753261
      newErrors.file_input = "File exceeds maximum allowed file size of 100mb";
    }

    if (!password) {
      newErrors.password = "Password cannot be empty";
    }

    if (Object.keys(newErrors).length > 0) {
      setFormErrors(newErrors);
      return false;
    }

    setFormErrors();
    return true;
  };

  // offer up the file!
  const initiateTransfer = async (e) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    // deal with keys/encryption
    const key = await genKey();
    const contents = await readFile(fileDetails);
    const encrypted = await encryptMessage(contents, key, password);
    const encodedKey = await exportKeyAsBase64(key);

    // post metadata to metadata service
    const validUntil = new Date(
      Date.now() + config.FILE_VALID_HOURS * 60 * 60 * 1000,
    );
    const metadata = {
      fileName: fileDetails.name,
      contentLengthBytes: encrypted.byteLength,
      privateKey: encodedKey,
      validUntil: validUntil,
    };
    const transferDetails = await fetch(config.TRANSFER_API, {
      method: "POST",
      mode: "cors", // TODO make this not CORS if possible
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metadata),
    }).then((resp) => resp.json());

    // set up receiver link
    const receiverLink = getReceiverLink(transferDetails.id);
    setReceiveLink(receiverLink);

    // open websocket to coordinate webrtc connection and transfer the file
    const socketUrl = new URL(config.COORD_API);
    socketUrl.searchParams.set("role", "offerer");
    socketUrl.searchParams.set("transfer_id", transferDetails.id);
    const socket = new WebSocket(socketUrl);

    const senders = new Map();

    // coordination logic for webrtc
    const senderSocketOnMessage = async (event) => {
      const { sender: senderAddress, body: rawBody } = JSON.parse(event.data);
      const body = JSON.parse(rawBody);

      switch (body.type) {
        case NEW_ANSWER: {
          const sender = senders[senderAddress];
          await sender.registerAnswer(body.answer);
          break;
        }
        case NEW_ICE_CANDIDATE: {
          const sender = senders[senderAddress];
          const candidate = new RTCIceCandidate(body.candidate);
          sender.addIceCandidate(candidate);
          break;
        }
        default:
          throw new Error(`Unsupported message type ${body.type}`);
      }
    };
    socket.onmessage = async function (event) {
      const { sender: senderAddress, body: rawBody } = JSON.parse(event.data);
      const body = JSON.parse(rawBody);

      switch (body.type) {
        case NEW_RECIPIENT: {
          const senderSocketUrl = new URL(config.COORD_API);
          senderSocketUrl.searchParams.set("role", "sender");
          senderSocketUrl.searchParams.set("transfer_id", transferDetails.id);
          const senderSocket = new WebSocket(senderSocketUrl);
          senderSocket.onmessage = senderSocketOnMessage;

          // need to wait for the socket to open
          await new Promise((resolve, reject) => {
            senderSocket.onopen = resolve;
          });

          const sender = new Sender(senderSocket, encrypted);
          sender.setRecipientAddress(senderAddress);
          senders[senderAddress] = sender;

          const offer = await sender.createOffer();
          const resp = { type: NEW_OFFER, offer };
          sender.sendMessage(resp);
          break;
        }
        default:
          throw new Error(`Unsupported message type ${body.type}`);
      }
    };
  };

  return (
    <div>
      <div className="lang-switch-container">
        <button onClick={handleLangSwitch} className="lang-switch-btn">
          {t.langSwitch}
        </button>
      </div>
      <form>
        <div className="form-field">
          <label>{t.howItWorks}</label>
          <div>
            <a href="https://sendfiles.dev/" target="_blank" rel="noopener noreferrer">sendfiles.dev</a> позволяет вам передавать файлы напрямую
            из одного браузера в другой без прохождения через промежуточный
            сервер, используя технологию{" "}
            <a
              href="https://webrtc.org/"
              target="_blank"
              rel="noopener noreferrer"
            >
              WebRTC
            </a>. Файлы шифруются в вашем браузере с использованием пароля, который вы
            указываете. Файлы расшифровываются в браузере получателя с помощью того же
            пароля. Нажмите <a href="/about">сюда</a>, чтобы узнать о свойствах безопасности.
          </div>
        </div>
        <div className="form-field">
          <label htmlFor="file_input">{t.selectFile}</label>
          <div className="form-description">
            {t.fileNote}
          </div>
          <input
            id="file_input"
            type="file"
            className={formErrors && formErrors.file_input ? "error" : ""}
            onChange={onFileSelected}
          />
          {formErrors && formErrors.file_input && (
            <div className="form-error">{formErrors.file_input}</div>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="password">{t.choosePassword}</label>
          <div className="form-description">
            {t.passwordNote}
          </div>
          <input
            id="password"
            type="password"
            className={formErrors && formErrors.password ? "error" : ""}
            placeholder={passwordPlaceholder}
            onChange={(e) => setPassword(e.target.value)}
            value={password}
          />
          {formErrors && formErrors.password && (
            <div className="form-error">{formErrors.password}</div>
          )}
        </div>
        {!receiveLink ? (
          <div>
            <label htmlFor="submit">{t.generateLink}</label>
            <div className="form-description">
              {t.generateNote}
            </div>
            <button
              id="submit"
              type="submit"
              className="filled submit-button"
              onClick={initiateTransfer}
            >
              {t.generate}
            </button>
          </div>
        ) : (
          <div>
            <label>{t.share}</label>
            <div className="instruction-browser-open">
              {t.keepWindowOpen}
            </div>
            <div className="form-description">
              {t.sendLink}
            </div>
            <div className="receive-link-container">
              <div className="receive-link">
                <a href={receiveLink} target="_blank" rel="noopener noreferrer">
                  {receiveLink}
                </a>
              </div>
              <div className="copy-button">
                <ClipboardButton content={receiveLink} />
              </div>
            </div>
          
            {/* QR Code Section */}
            <div className="qr-section">
              <div className="qr-header">
                <label>{t.qrCodeLabel}</label>
                <button 
                  type="button" 
                  className="qr-settings-toggle"
                  onClick={() => setShowQRSettings(!showQRSettings)}
                >
                  {showQRSettings ? t.hideSettings : t.settings}
                </button>
              </div>
              
              {showQRSettings && (
                <div className="qr-settings">
                  <div className="qr-setting-row">
                    <label htmlFor="qr-size">{t.sizePixels}</label>
                    <input
                      id="qr-size"
                      type="number"
                      min="64"
                      max="2000"
                      step="32"
                      value={qrSize}
                      onChange={(e) => setQrSize(Number(e.target.value))}
                    />
                  </div>
                  <div className="qr-setting-row">
                    <label htmlFor="qr-level">{t.errorCorrection}:</label>
                    <select
                      id="qr-level"
                      value={qrLevel}
                      onChange={(e) => setQrLevel(e.target.value)}
                    >
                      <option value="L">{t.low}</option>
                      <option value="M">{t.medium}</option>
                      <option value="Q">{t.quartile}</option>
                      <option value="H">{t.high}</option>
                    </select>
                  </div>
                </div>
              )}
              
              <div className="qr-code-wrapper">
                <QRCodeSVG 
                  value={receiveLink}
                  size={qrSize}
                  level={qrLevel}
                  bgColor="#ffffff"
                  fgColor="#000000"
                />
              </div>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

export default SendApp;
