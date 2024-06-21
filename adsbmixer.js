const net = require('net');

const feedPort = 46666;
const outputPort = 58511;

const connectedClients = new Set();

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
    sendToClients(message);
  }
}

function sendToClients(message) {
  for (const socket of connectedClients) {
    socket.write(message + '\n');
  }
} 
