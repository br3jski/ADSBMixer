const net = require('net');

const feedPort = 46666;
const outputPortText = 58511;
const outputPortBinary = 58512;
const tokenPort = 8888;

const connectedClientsText = new Set();
const connectedClientsBinary = new Set();

let tokenClient = null;
let reconnectInterval = 5000;

function connectToTokenServer() {
    if (tokenClient) {
        tokenClient.destroy();
    }

    tokenClient = new net.Socket();

    tokenClient.connect(tokenPort, '10.0.0.17', () => {
        console.log('Połączono z serwerem tokenów');
        reconnectInterval = 5000;
    });

    tokenClient.on('error', (error) => {
        console.error('Błąd połączenia z serwerem tokenów:', error.message);
    });

    tokenClient.on('close', () => {
        console.log('Połączenie z serwerem tokenów zostało zamknięte. Próba ponownego połączenia...');
        setTimeout(connectToTokenServer, reconnectInterval);
        reconnectInterval = Math.min(reconnectInterval * 2, 60000);
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

function processData(data, ipAddress) {
    let offset = 0;
    while (offset < data.length) {
        console.log(`Przetwarzanie danych od offsetu ${offset}, długość danych: ${data.length}`);
        
        // Sprawdź, czy to token
        if (data.slice(offset).toString().startsWith('TOKEN:')) {
            const newlineIndex = data.indexOf('\n', offset);
            if (newlineIndex !== -1) {
                const tokenLine = data.slice(offset, newlineIndex).toString().trim();
                const token = tokenLine.slice(6).trim();
                sendTokenInfo(token, ipAddress);
                offset = newlineIndex + 1;
                console.log('Przetworzono token');
            } else {
                console.log('Niepełny token, oczekiwanie na więcej danych');
                break;
            }
        } else {
            // Sprawdź, czy to dane binarne
            let isBinary = false;
            for (let i = offset; i < Math.min(offset + 10, data.length); i++) {
                if (data[i] === 0x1a) {
                    isBinary = true;
                    break;
                }
            }

            if (isBinary) {
                console.log('Wykryto dane binarne');
                let endIndex = data.indexOf(0x1a, offset + 1);
                if (endIndex === -1) {
                    endIndex = data.length;
                } else {
                    endIndex++; // Uwzględnij końcowy znacznik
                }
                const binaryData = data.slice(offset, endIndex);
                console.log(`Wysyłanie danych binarnych, długość: ${binaryData.length}`);
                sendToBinaryClients(binaryData);
                offset = endIndex;
            } else {
                // Dane tekstowe
                const newlineIndex = data.indexOf('\n', offset);
                if (newlineIndex !== -1) {
                    const textData = data.slice(offset, newlineIndex + 1);
                    console.log(`Wysyłanie danych tekstowych, długość: ${textData.length}`);
                    sendToTextClients(textData);
                    offset = newlineIndex + 1;
                } else {
                    console.log('Niepełna linia tekstu, oczekiwanie na więcej danych');
                    break;
                }
            }
        }
    }
    return data.slice(offset);
}

const feedServer = net.createServer(feedSocket => {
    console.log(`Nowe połączenie od ${feedSocket.remoteAddress}:${feedSocket.remotePort}`);

    let buffer = Buffer.alloc(0);

    feedSocket.on('data', data => {
        buffer = Buffer.concat([buffer, data]);
        buffer = processData(buffer, feedSocket.remoteAddress);
    });

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

function sendToBinaryClients(data) {
    console.log(`Próba wysłania danych binarnych o długości: ${data.length}`);
    if (connectedClientsBinary.size === 0) {
        console.log('Brak podłączonych klientów binarnych');
    }
    sendToClients(connectedClientsBinary, data);
}

function sendToTextClients(data) {
    console.log(`Próba wysłania danych tekstowych o długości: ${data.length}`);
    if (connectedClientsText.size === 0) {
        console.log('Brak podłączonych klientów tekstowych');
    }
    sendToClients(connectedClientsText, data);
}

process.on('uncaughtException', (error) => {
    console.error('Nieoczekiwany błąd:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Nieobsłużone odrzucenie obietnicy:', reason);
});

// Dodaj to na końcu pliku, aby monitorować połączenia klientów
setInterval(() => {
    console.log(`Liczba podłączonych klientów tekstowych: ${connectedClientsText.size}`);
    console.log(`Liczba podłączonych klientów binarnych: ${connectedClientsBinary.size}`);
}, 10000);