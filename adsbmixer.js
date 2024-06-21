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
  // Sprawdzamy, czy dane zaczynają się od charakterystycznych bajtów formatu AVR/Beast
  return data[0] === 0x1a || data[0] === 0x31 || data[0] === 0x32 || data[0] === 0x33;
}

const feedServer = net.createServer(feedSocket => {
  console.log(`Nowe połączenie od ${feedSocket.remoteAddress}:${feedSocket.remotePort}`);

  feedSocket.on('data', data => {
    processData(data);
  });

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

function processData(data) {
  if (isBinaryData(data)) {
    sendToBinaryClients(data);
  } else {
    const messages = data.toString().trim().split('\n');
    for (const message of messages) {
      if (isValidMessage(message)) {
        sendToTextClients(message);
      } else {
        console.log('Odrzucono niepoprawną wiadomość:', message);
      }
    }
  }
}

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