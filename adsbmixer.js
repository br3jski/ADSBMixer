const net = require('net');

const feedPort = 46666;
const outputPortText = 58511;
const outputPortBinary = 58512;
const tokenPort = 8888;  // Port dla danych o tokenach

const connectedClientsText = new Set();
const connectedClientsBinary = new Set();

const MSG_TYPES = new Set(['1', '2', '3', '4', '5', '6', '7', '8']);
const MIN_FIELDS = 10;

let tokenClient = null;
let reconnectInterval = 5000; // 5 sekund między próbami ponownego połączenia

function connectToTokenServer() {
    if (tokenClient) {
        tokenClient.destroy();
    }

    tokenClient = new net.Socket();

    tokenClient.connect(tokenPort, '10.0.0.17', () => {
        console.log('Połączono z serwerem tokenów');
        reconnectInterval = 5000; // Reset interwału do wartości początkowej po udanym połączeniu
    });

    tokenClient.on('error', (error) => {
        console.error('Błąd połączenia z serwerem tokenów:', error.message);
    });

    tokenClient.on('close', () => {
        console.log('Połączenie z serwerem tokenów zostało zamknięte. Próba ponownego połączenia...');
        setTimeout(connectToTokenServer, reconnectInterval);
        reconnectInterval = Math.min(reconnectInterval * 2, 60000); // Zwiększ interwał, max 1 minuta
    });
}

connectToTokenServer();

function sendTokenInfo(token, ipAddress) {
    console.log(`Nowy token otrzymany: ${token} od IP: ${ipAddress}`);
    const tokenInfo = JSON.stringify({ token, ipAddress });
    if (tokenClient && tokenClient.writable) {
        tokenClient.write(tokenInfo + '\n');
        console.log(`Token wysłany do serwera docelowego`);
    } else {
        console.log(`Nie można wysłać tokenu. Serwer tokenów jest niedostępny.`);
    }
}

function isValidMessage(message) {
    const fields = message.split(',');
  
    if (fields.length < MIN_FIELDS) return false;
    if (fields[0] !== 'MSG' || !MSG_TYPES.has(fields[1])) return false;
  
    const dateTimeRegex = /^\d{4}\/\d{2}\/\d{2},\d{2}:\d{2}:\d{2}\.\d{3}$/;
    if (!dateTimeRegex.test(fields[6] + ',' + fields[7])) return false;
  
    if (fields[1] === '3') {
        if (fields.length < 16 || isNaN(parseFloat(fields[14])) || isNaN(parseFloat(fields[15]))) return false;
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
            // Sprawdź, czy mamy pełną linię
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex === -1) {
                // Jeśli nie ma pełnej linii, czekamy na więcej danych
                break;
            }
    
            const line = buffer.slice(0, newlineIndex).toString().trim();
            buffer = buffer.slice(newlineIndex + 1);
    
            // Obsługa tokena
            if (line.startsWith('TOKEN:')) {
                currentToken = line.slice(6).trim();
                sendTokenInfo(currentToken, feedSocket.remoteAddress);
                continue;
            }
    
            // Obsługa danych binarnych
            if (isBinaryData(Buffer.from(line))) {
                sendToBinaryClients(Buffer.from(line));
            } else {
                // Obsługa danych tekstowych
                if (isValidMessage(line)) {
                    sendToTextClients(line);
                } else {
                    console.log(`Pominięto nieprawidłową wiadomość: ${line.substring(0, 50)}...`);
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

// Obsługa nieoczekiwanych błędów
process.on('uncaughtException', (error) => {
    console.error('Nieoczekiwany błąd:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Nieobsłużone odrzucenie obietnicy:', reason);
});
