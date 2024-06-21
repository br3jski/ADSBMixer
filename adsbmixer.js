const net = require('net');

const feedPort = 46666;
const outputPortText = 58511;
const outputPortBinary = 58512;

const connectedClientsText = new Set();
const connectedClientsBinary = new Set();

const MSG_TYPES = new Set(['1', '2', '3', '4', '5', '6', '7', '8']);
const MIN_FIELDS = 10;

function isValidMessage(message) {
  const fields = message.split(',');
  
  if (fields.length < MIN_FIELDS) return false;
  if (fields[0] !== 'MSG' || !MSG_TYPES.has(fields[1])) return false;
  
  const dateTimeRegex = /^\d{4}\/\d{2}\/\d{2},\d{2}:\d{2}:\d{2}\.\d{3}$/;
  if (!dateTimeRegex.test(fields[6] + ',' + fields[7])) return false;
  
  if (fields[1] === '3') {
    if (isNaN(parseFloat(fields[14])) || isNaN(parseFloat(fields[15]))) return false;
  }
  return true;
}

function isBinaryData(data) {
  // Sprawdzamy pierwsze kilka bajtów, czy pasują do formatu AVR/Beast
  const header = data.slice(0, 3);
  return header[0] === 0x1a && (header[1] === 0x31 || header[1] === 0x32 || header[1] === 0x33);
}

const feedServer = net.createServer(feedSocket => {
  console.log(`Nowe połączenie od ${feedSocket.remoteAddress}:${feedSocket.remotePort}`);

  let buffer = Buffer.alloc(0);

  feedSocket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    processBuffer();
  });

  function processBuffer() {
    if (isBinaryData(buffer)) {
      sendToBinaryClients(buffer);
      buffer = Buffer.alloc(0);
    } else {
      let textEnd = buffer.indexOf('\n');
      while (textEnd !== -1) {
        const message = buffer.slice(0, textEnd).toString().trim();
        if (isValidMessage(message)) {
          sendToTextClients(message);
        } else {
          console.log('Odrzucono niepoprawną wiadomość:', message);
        }
        buffer = buffer.slice(textEnd + 1);
        textEnd = buffer.indexOf('\n');
      }
    }
  }

  feedSocket.on('close', () => {
    console.log(`Połączenie zakończone z ${feedSocket.remoteAddress}:${feedSocket.remotePort}`);
  });
});

feedServer.listen(feedPort, () => {
  console.log(`Serwer nasłuchuje na porcie ${feedPort}`);
});

const outputServerText = net.createServer(outputSocket => {
  console.log(`Klient tekstowy połączony: ${outputSocket.remoteAddress}:${outputSocket.remotePort}`);
  connectedClientsText.add(outputSocket);

  outputSocket.on('close', () => {
    console.log(`Klient tekstowy rozłączony: ${outputSocket.remoteAddress}:${outputSocket.remotePort}`);
    connectedClientsText.delete(outputSocket);
  });
});

outputServerText.listen(outputPortText, '10.0.0.1', () => {
  console.log(`Serwer tekstowy nasłuchuje na porcie ${outputPortText}`);
});

const outputServerBinary = net.createServer(outputSocket => {
  console.log(`Klient binarny połączony: ${outputSocket.remoteAddress}:${outputSocket.remotePort}`);
  connectedClientsBinary.add(outputSocket);

  outputSocket.on('close', () => {
    console.log(`Klient binarny rozłączony: ${outputSocket.remoteAddress}:${outputSocket.remotePort}`);
    connectedClientsBinary.delete(outputSocket);
  });
});

outputServerBinary.listen(outputPortBinary, '10.0.0.1', () => {
  console.log(`Serwer binarny nasłuchuje na porcie ${outputPortBinary}`);
});

function sendToTextClients(message) {
  for (const socket of connectedClientsText) {
    socket.write(message + '\n');
  }
}

function sendToBinaryClients(data) {
  for (const socket of connectedClientsBinary) {
    socket.write(data);
  }
}