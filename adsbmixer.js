const net = require('net');

const feedPort = 46666;
const outputPortText = 58511;
const outputPortBinary = 58512;
const tokenPort = 8888;  // Port dla danych o tokenach

const connectedClientsText = new Set();
const connectedClientsBinary = new Set();

const MSG_TYPES = new Set(['1', '2', '3', '4', '5', '6', '7', '8']);
const MIN_FIELDS = 10;

const tokenClient = new net.Socket();
tokenClient.connect(tokenPort, '10.0.0.17', () => {
    console.log('Połączono z serwerem tokenów');
});

tokenClient.on('error', (error) => {
    console.error('Błąd połączenia z serwerem tokenów:', error.message);
});

function sendTokenInfo(token, ipAddress) {
  console.log(`Nowy token otrzymany: ${token} od IP: ${ipAddress}`);
  const tokenInfo = JSON.stringify({ token, ipAddress });
  tokenClient.write(tokenInfo + '\n');
  console.log(`Token wysłany do serwera docelowego`);
}


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
    const header = data.slice(0, 3);
    return header[0] === 0x1a && (header[1] === 0x31 || header[1] === 0x32 || header[1] === 0x33);
}

const feedServer = net.createServer(feedSocket => {
  console.log(`Nowe połączenie od ${feedSocket.remoteAddress}:${feedSocket.remotePort}`);

  let buffer = Buffer.alloc(0);
  let currentToken = null;

  feedSocket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      processBuffer();
  });

  function processBuffer() {
      while (buffer.length > 0) {
          if (buffer.toString().startsWith('TOKEN:')) {
              const tokenEnd = buffer.indexOf('\n');
              if (tokenEnd !== -1) {
                  currentToken = buffer.slice(6, tokenEnd).toString().trim();
                  sendTokenInfo(currentToken, feedSocket.remoteAddress);
                  buffer = buffer.slice(tokenEnd + 1);
              } else {
                  break;  // Niepełny token, czekamy na więcej danych
              }
          } else if (isBinaryData(buffer)) {
              sendToBinaryClients(buffer);
              buffer = Buffer.alloc(0);
          } else {
              const textEnd = buffer.indexOf('\n');
              if (textEnd !== -1) {
                  const message = buffer.slice(0, textEnd).toString().trim();
                  if (isValidMessage(message)) {
                      sendToTextClients(message);
                  }
                  buffer = buffer.slice(textEnd + 1);
              } else {
                  break;  // Niepełna wiadomość, czekamy na więcej danych
              }
          }
      }
  }

    feedSocket.on('close', () => {
        console.log(`Połączenie zakończone z ${feedSocket.remoteAddress}:${feedSocket.remotePort}`);
    });

    feedSocket.on('error', (error) => {
        console.error(`Błąd połączenia z ${feedSocket.remoteAddress}:${feedSocket.remotePort}:`, error.message);
        feedSocket.destroy();
    });
});

feedServer.on('error', (error) => {
    console.error('Błąd serwera feed:', error.message);
});

feedServer.listen(feedPort, () => {
    console.log(`Serwer nasłuchuje na porcie ${feedPort}`);
});

function createOutputServer(port, isTextServer) {
    const server = net.createServer(outputSocket => {
        const clientType = isTextServer ? 'tekstowy' : 'binarny';
        console.log(`Klient ${clientType} połączony: ${outputSocket.remoteAddress}:${outputSocket.remotePort}`);
    
        const clientSet = isTextServer ? connectedClientsText : connectedClientsBinary;
        clientSet.add(outputSocket);

        outputSocket.on('close', () => {
            console.log(`Klient ${clientType} rozłączony: ${outputSocket.remoteAddress}:${outputSocket.remotePort}`);
            clientSet.delete(outputSocket);
        });

        outputSocket.on('error', (error) => {
            console.error(`Błąd połączenia klienta ${clientType} ${outputSocket.remoteAddress}:${outputSocket.remotePort}:`, error.message);
            clientSet.delete(outputSocket);
            outputSocket.destroy();
        });
    });

    server.on('error', (error) => {
        console.error(`Błąd serwera ${isTextServer ? 'tekstowego' : 'binarnego'}:`, error.message);
    });

    server.listen(port, '10.0.0.1', () => {
        console.log(`Serwer ${isTextServer ? 'tekstowy' : 'binarny'} nasłuchuje na porcie ${port}`);
    });

    return server;
}

const outputServerText = createOutputServer(outputPortText, true);
const outputServerBinary = createOutputServer(outputPortBinary, false);

function sendToClients(clients, data) {
    for (const socket of clients) {
        try {
            const success = socket.write(data);
            if (!success) {
                console.warn(`Nie udało się wysłać danych do klienta ${socket.remoteAddress}:${socket.remotePort}`);
            }
        } catch (error) {
            console.error(`Błąd podczas wysyłania danych do klienta ${socket.remoteAddress}:${socket.remotePort}:`, error.message);
            clients.delete(socket);
            socket.destroy();
        }
    }
}

function sendToTextClients(message) {
    sendToClients(connectedClientsText, message + '\n');
}

function sendToBinaryClients(data) {
    sendToClients(connectedClientsBinary, data);
}

function sendTokenInfo(token, ipAddress) {
    const tokenInfo = JSON.stringify({ token, ipAddress });
    tokenClient.write(tokenInfo + '\n');
}

// Obsługa nieoczekiwanych błędów
process.on('uncaughtException', (error) => {
    console.error('Nieoczekiwany błąd:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Nieobsłużone odrzucenie obietnicy:', reason);
});