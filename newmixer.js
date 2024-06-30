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

function extractTokenAndProcess(data, ipAddress) {
    let token = null;
    let processedData = data;

    const tokenIndex = data.indexOf('TOKEN:');
    if (tokenIndex !== -1) {
        const newlineIndex = data.indexOf('\n', tokenIndex);
        if (newlineIndex !== -1) {
            token = data.slice(tokenIndex + 6, newlineIndex).toString().trim();
            processedData = Buffer.concat([
                data.slice(0, tokenIndex),
                data.slice(newlineIndex + 1)
            ]);
            sendTokenInfo(token, ipAddress);
        }
    }

    return { token, processedData };
}

function isBaseStationFormat(data) {
    const firstLine = data.toString().split('\n')[0];
    return firstLine.startsWith('MSG,') && firstLine.split(',').length >= 10;
}

function processData(data, ipAddress) {
    const { processedData } = extractTokenAndProcess(data, ipAddress);

    if (processedData[0] === 0x1a) {
        console.log('Wykryto dane binarne (AVR/Beast)');
        sendToBinaryClients(processedData);
    } else if (isBaseStationFormat(processedData)) {
        console.log('Wykryto dane tekstowe (BaseStation)');
        sendToTextClients(processedData);
    } else {
        console.log('Nierozpoznany format danych, traktowanie jako binarne');
        sendToBinaryClients(processedData);
    }

    return Buffer.alloc(0); // Zwracamy pusty bufor, bo wszystkie dane zostały przetworzone
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

setInterval(() => {
    console.log(`Liczba podłączonych klientów tekstowych: ${connectedClientsText.size}`);
    console.log(`Liczba podłączonych klientów binarnych: ${connectedClientsBinary.size}`);
}, 10000);