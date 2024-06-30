const net = require('net');

const feedPort = 46666;
const outputPortText = 58511;
const outputPortBinary = 58512;
const tokenPort = 8888;

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
    try {
        const firstLine = data.toString().split('\n')[0];
        const fields = firstLine.split(',');
        return firstLine.startsWith('MSG,') && fields.length >= 22;
    } catch (error) {
        return false;
    }
}

function processData(data, ipAddress) {
    const { processedData } = extractTokenAndProcess(data, ipAddress);

    console.log('Typ danych:', typeof processedData);
    console.log('Pierwsze kilka bajtów:', processedData.slice(0, 10));

    if (isBaseStationFormat(processedData)) {
        console.log('Wykryto dane tekstowe (BaseStation)');
        console.log(`Dane tekstowe: ${processedData.toString().slice(0, 100)}`);
        sendToTextClients(processedData);
    } else {
        console.log('Wykryto dane binarne (AVR/Beast) lub nierozpoznany format');
        console.log(`Dane binarne: ${processedData.slice(0, 50).toString('hex')}`);
        sendToBinaryClients(processedData);
    }

    return Buffer.alloc(0);
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

const textClients = new Set();
const binaryClients = new Set();

const textServer = net.createServer(socket => {
    console.log(`Klient tekstowy połączony: ${socket.remoteAddress}:${socket.remotePort}`);
    textClients.add(socket);
    console.log(`Liczba klientów tekstowych po dodaniu: ${textClients.size}`);

    socket.on('close', () => {
        console.log(`Klient tekstowy rozłączony: ${socket.remoteAddress}:${socket.remotePort}`);
        textClients.delete(socket);
        console.log(`Liczba klientów tekstowych po usunięciu: ${textClients.size}`);
    });

    socket.on('error', (error) => {
        console.error(`Błąd klienta tekstowego ${socket.remoteAddress}:${socket.remotePort}:`, error.message);
        textClients.delete(socket);
        console.log(`Liczba klientów tekstowych po błędzie: ${textClients.size}`);
    });
});

textServer.listen(outputPortText, '0.0.0.0', () => {
    console.log(`Serwer tekstowy nasłuchuje na porcie ${outputPortText}`);
});

const binaryServer = net.createServer(socket => {
    console.log(`Klient binarny połączony: ${socket.remoteAddress}:${socket.remotePort}`);
    binaryClients.add(socket);
    console.log(`Liczba klientów binarnych po dodaniu: ${binaryClients.size}`);

    socket.on('close', () => {
        console.log(`Klient binarny rozłączony: ${socket.remoteAddress}:${socket.remotePort}`);
        binaryClients.delete(socket);
        console.log(`Liczba klientów binarnych po usunięciu: ${binaryClients.size}`);
    });

    socket.on('error', (error) => {
        console.error(`Błąd klienta binarnego ${socket.remoteAddress}:${socket.remotePort}:`, error.message);
        binaryClients.delete(socket);
        console.log(`Liczba klientów binarnych po błędzie: ${binaryClients.size}`);
    });
});

binaryServer.listen(outputPortBinary, '0.0.0.0', () => {
    console.log(`Serwer binarny nasłuchuje na porcie ${outputPortBinary}`);
});

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
    console.log(`Próba wysłania danych binarnych o długości: ${data.length} na port ${outputPortBinary}`);
    console.log(`Pierwsze 50 bajtów danych binarnych: ${data.slice(0, 50).toString('hex')}`);
    sendToClients(binaryClients, data);
}

function sendToTextClients(data) {
    console.log(`Próba wysłania danych tekstowych o długości: ${data.length} na port ${outputPortText}`);
    console.log(`Pierwsze 100 znaków danych tekstowych: ${data.slice(0, 100).toString()}`);
    sendToClients(textClients, data);
}

process.on('uncaughtException', (error) => {
    console.error('Nieoczekiwany błąd:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Nieobsłużone odrzucenie obietnicy:', reason);
});

setInterval(() => {
    console.log(`Liczba podłączonych klientów tekstowych: ${textClients.size}`);
    console.log(`Liczba podłączonych klientów binarnych: ${binaryClients.size}`);
}, 10000);