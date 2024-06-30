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
    if (message.includes('TOKEN:')) {
        console.log('Wiadomość zawiera TOKEN, pomijanie');
        return false;
    }

    const fields = message.split(',');
  
    if (fields.length < MIN_FIELDS) {
        console.log(`Niewystarczająca liczba pól: ${fields.length}`);
        return false;
    }
    if (fields[0] !== 'MSG' || !MSG_TYPES.has(fields[1])) {
        console.log(`Nieprawidłowy typ wiadomości: ${fields[0]}, ${fields[1]}`);
        return false;
    }
  
    const dateTimeRegex = /^\d{4}\/\d{2}\/\d{2},\d{2}:\d{2}:\d{2}\.\d{3}$/;
    if (fields.length > 7 && !dateTimeRegex.test(fields[6] + ',' + fields[7])) {
        console.log(`Nieprawidłowy format daty/czasu`);
        return false;
    }
  
    if (fields[1] === '3') {
        if (fields.length < 16) {
            console.log(`Niewystarczająca liczba pól dla typu 3`);
            return false;
        }
        const lat = parseFloat(fields[14]);
        const lon = parseFloat(fields[15]);
        if (isNaN(lat) || isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            console.log(`Nieprawidłowe współrzędne: ${lat}, ${lon}`);
            return false;
        }
    }
    return true;
}

function isBinaryData(data) {
    const checkLength = Math.min(data.length, 64);
    for (let i = 0; i < checkLength; i++) {
        if (data[i] < 32 || data[i] > 126) {
            return true;
        }
    }
    return false;
}

const feedServer = net.createServer(feedSocket => {
    console.log(`Nowe połączenie od ${feedSocket.remoteAddress}:${feedSocket.remotePort}`);

    let buffer = Buffer.alloc(0);

    feedSocket.on('data', data => {
        buffer = Buffer.concat([buffer, data]);
        processBuffer();
    });

    function processBuffer() {
        while (buffer.length > 0) {
            // Najpierw sprawdź, czy mamy token
            if (buffer.toString().startsWith('TOKEN:')) {
                const newlineIndex = buffer.indexOf('\n');
                if (newlineIndex !== -1) {
                    const tokenLine = buffer.slice(0, newlineIndex).toString().trim();
                    const token = tokenLine.slice(6).trim();
                    sendTokenInfo(token, feedSocket.remoteAddress);
                    buffer = buffer.slice(newlineIndex + 1);
                    continue;
                } else {
                    // Niepełny token, czekamy na więcej danych
                    break;
                }
            }

            // Sprawdź, czy mamy do czynienia z danymi binarnymi
            if (isBinaryData(buffer)) {
                const chunkSize = Math.min(buffer.length, 1024);
                const chunk = buffer.slice(0, chunkSize);
                sendToBinaryClients(chunk);
                buffer = buffer.slice(chunkSize);
                continue;
            }

            // Obsługa wiadomości tekstowych
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex === -1) {
                if (buffer.length > 10240) { // 10 KB
                    buffer = buffer.slice(buffer.length - 10240);
                }
                break;
            }

            const line = buffer.slice(0, newlineIndex).toString().trim();
            buffer = buffer.slice(newlineIndex + 1);

            // Dodatkowe sprawdzenie, czy linia nie zawiera tokena
            if (line.startsWith('TOKEN:')) {
                const token = line.slice(6).trim();
                sendTokenInfo(token, feedSocket.remoteAddress);
            } else if (isValidMessage(line)) {
                console.log(`Znaleziono prawidłową wiadomość tekstową: ${line.substring(0, 50)}...`);
                sendToTextClients(line);
            } else {
                console.log(`Pominięto nieprawidłową wiadomość: ${line.substring(0, 50)}...`);
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
    console.log(`Próba wysłania danych do ${clients.size} klientów`);
    for (const socket of clients) {
        try {
            const success = socket.write(data);
            if (!success) {
                console.warn(`Nie udało się wysłać danych do klienta ${socket.remoteAddress}:${socket.remotePort}`);
            } else {
                console.log(`Dane wysłane do klienta ${socket.remoteAddress}:${socket.remotePort}`);
            }
        } catch (error) {
            console.error(`Błąd podczas wysyłania danych do klienta ${socket.remoteAddress}:${socket.remotePort}:`, error.message);
            clients.delete(socket);
            socket.destroy();
        }
    }
}

function sendToTextClients(message) {
    console.log(`Wysyłanie danych tekstowych: ${message.substring(0, 50)}...`);
    sendToClients(connectedClientsText, message + '\n');
}

function sendToBinaryClients(data) {
    console.log(`Wysyłanie danych binarnych o długości: ${data.length}`);
    sendToClients(connectedClientsBinary, data);
}

// Obsługa nieoczekiwanych błędów
process.on('uncaughtException', (error) => {
    console.error('Nieoczekiwany błąd:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Nieobsłużone odrzucenie obietnicy:', reason);
});