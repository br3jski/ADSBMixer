const net = require('net');

const feedPort = 46666;
const outputPort = 58511;

const connectedClients = new Set();

// Define the message structure
const MSG_TYPES = new Set(['1', '2', '3', '4', '5', '6', '7', '8']);
const MIN_FIELDS = 10;  // Minimum number of fields in a message

function isValidMessage(message) {
  const fields = message.split(',');
  
  // Check if the message has enough fields
  if (fields.length < MIN_FIELDS) return false;
  
  // Check if the message type is valid
  if (fields[0] !== 'MSG' || !MSG_TYPES.has(fields[1])) return false;
  
  // Check if the timestamp is in the correct format
  const dateTimeRegex = /^\d{4}\/\d{2}\/\d{2},\d{2}:\d{2}:\d{2}\.\d{3}$/;
  if (!dateTimeRegex.test(fields[6] + ',' + fields[7])) return false;
  
  // Check if the coordinates are numbers
  if (fields[1] === '3') {
    if (isNaN(parseFloat(fields[14])) || isNaN(parseFloat(fields[15]))) return false;
  }
  return true;
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

const outputServer = net.createServer(outputSocket => {
  console.log(`Klient połączony: ${outputSocket.remoteAddress}:${outputSocket.remotePort}`);
  connectedClients.add(outputSocket);

  outputSocket.on('close', () => {
    console.log(`Klient rozłączony: ${outputSocket.remoteAddress}:${outputSocket.remotePort}`);
    connectedClients.delete(outputSocket);
  });
});

outputServer.listen(outputPort, '10.0.0.1', () => {
  console.log(`Serwer nasłuchuje na porcie ${outputPort}`);
});

function processData(data) {
  const messages = data.toString().trim().split('\n');
  
  for (const message of messages) {
    if (isValidMessage(message)) {
      sendToClients(message);
    } else {
      console.log('Odrzucono niepoprawną wiadomość:', message);
    }
  }
}

function sendToClients(message) {
  for (const socket of connectedClients) {
    socket.write(message + '\n');
  }
} 
