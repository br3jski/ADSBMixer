const net = require('net');
const fs = require('fs');

const feedPort = 46666;
const outputPortText = 58511;
const outputPortBinary = 58512;
const tokenPort = 8888;

let tokenClient = null;
let reconnectInterval = 5000;
const logFile = fs.createWriteStream('debug.log', { flags: 'a' });

function logToFile(message) {
    logFile.write(`${new Date().toISOString()} - ${message}\n`, (err) => {
        if (err) {
            console.error('Błąd zapisu do pliku logu:', err);
        }
    });
}

function connectToTokenServer() {
    if (tokenClient) {
        tokenClient.destroy();
    }

    tokenClient = new net.Socket();

    tokenClient.connect(tokenPort, '10.0.0.17', () => {
        logToFile('Połączono z serwerem tokenów');
        reconnectInterval = 5000;
    });

    tokenClient.on('error', (error) => {
        logToFile(`Błąd połączenia z serwerem tokenów: ${error.message}`);
    });

    tokenClient.on('close', () => {
        logToFile('Połączenie z serwerem tokenów zostało zamknięte. Próba ponownego połączenia...');
        setTimeout(connectToTokenServer, reconnectInterval);
        reconnectInterval = Math.min(reconnectInterval * 2, 60000);
    });
}

connectToTokenServer();

function sendTokenInfo(token, ipAddress) {
    logToFile(`Nowy token otrzymany: ${token} od IP: ${ipAddress}`);
    const tokenInfo = JSON.stringify({ token, ipAddress });
    if (tokenClient && tokenClient.writable) {
        tokenClient.write(tokenInfo + '\n');
        logToFile(`Token wysłany do serwera docelowego`);
    } else {
        logToFile(`Nie można wysłać tokenu. Serwer tokenów jest niedostępny.`);
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
            logToFile(`Token znaleziony i usunięty: ${token}`);
        }
    }

    logToFile(`Przetworzone dane po wycięciu tokena: ${processedData.toString()}`);
    return { token, processedData };
}

function isBaseStationFormat(data) {
    const baseStationRegex = /^MSG,(\d+),(\d+),(\d+),([A-Fa-f0-9]{6}),(\d+),(\d{4}\/\d{2}\/\d{2}),(\d{2}:\d{2}:\d{2}\.\d{3}),(\d{4}\/\d{2}\/\d{2}),(\d{2}:\d{2}:\d{2}\.\d{3}),(.*)$/;
    const dataString = data.toString().trim();
    const lines = dataString.split('\n');
    const isMatch = lines.some(line => baseStationRegex.test(line.trim()));
    logToFile(`Sprawdzanie formatu danych: ${dataString.substring(0, 100)}...`);
    logToFile(`Czy dane pasują do formatu BaseStation: ${isMatch}`);
    return isMatch;
}

function processData(data, ipAddress) {
    // Sprawdź, czy dane są w formacie BaseStation
    const dataString = data.toString().trim();
    const isBaseStation = dataString.startsWith('MSG,');

    if (isBaseStation) {
        const lines = dataString.split('\n');
        const processedLines = [];
        let tokensExtracted = 0;

        for (const line of lines) {
            const parts = line.split(',');
            if (parts.length === 22) {
                // Sprawdź, czy callsign (pole 10) zawiera token
                if (parts[10].includes('TOKEN:')) {
                    const token = extractTokenFromCallsign(parts[10]);
                    if (token) {
                        sendTokenInfo(token, ipAddress);
                        parts[10] = ''; // Usuwamy callsign zawierający token
                        tokensExtracted++;
                    }
                }
                const processedLine = parts.join(',');
                if (validateBaseStationLine(processedLine)) {
                    processedLines.push(processedLine);
                } else {
                    logToFile(`Odrzucona linia BaseStation: ${processedLine}`);
                }
            } else {
                logToFile(`Nieprawidłowa liczba pól BaseStation: ${line}`);
            }
        }

        if (processedLines.length > 0) {
            sendToTextClients(Buffer.from(processedLines.join('\n') + '\n'));
        }

        totalMessages += lines.length;
        validMessages += processedLines.length;
        invalidMessages += lines.length - processedLines.length;
    } else {
        // Dane binarne
        logToFile(`Otrzymano dane binarne o długości: ${data.length} bajtów`);
        sendToBinaryClients(data);
        totalMessages += 1;
        validMessages += 1; // Zakładamy, że dane binarne są zawsze poprawne
    }

    // Logowanie statystyk
    const currentTime = Date.now();
    if (currentTime - lastReportTime >= REPORT_INTERVAL) {
        const errorRate = invalidMessages / totalMessages;
        logToFile(`Statystyki: Łącznie ${totalMessages} wiadomości, ${validMessages} poprawnych, ${invalidMessages} (${(errorRate * 100).toFixed(2)}%) niepoprawnych`);
        if (isBaseStation) {
            logToFile(`Wyekstrahowano ${tokensExtracted} tokenów z danych BaseStation`);
        }
        
        if (errorRate > ERROR_THRESHOLD) {
            logToFile(`UWAGA: Procent uszkodzonych wiadomości (${(errorRate * 100).toFixed(2)}%) przekroczył próg ${ERROR_THRESHOLD * 100}%`);
        }

        // Resetuj liczniki
        totalMessages = 0;
        validMessages = 0;
        invalidMessages = 0;
        lastReportTime = currentTime;
    }

    return Buffer.alloc(0);
}

function extractTokenFromCallsign(callsign) {
    const tokenMatch = callsign.match(/TOKEN:ADS-[a-f0-9]{32}/);
    return tokenMatch ? tokenMatch[0].slice(6) : null; // Zwracamy token bez prefiksu "TOKEN:"
}

function validateBaseStationLine(line) {
    const parts = line.split(',');
    if (parts.length !== 22) return false; // BaseStation format powinien mieć dokładnie 22 pola

    // Sprawdź typ wiadomości (powinien być liczbą od 1 do 8)
    if (!/^[1-8]$/.test(parts[1])) return false;

    // Sprawdź format ICAO (6 znaków szesnastkowych)
    if (!/^[A-Fa-f0-9]{6}$/.test(parts[4])) return false;

    // Sprawdź format daty i czasu
    const dateTimeRegex = /^\d{4}\/\d{2}\/\d{2},\d{2}:\d{2}:\d{2}\.\d{3}$/;
    if (!dateTimeRegex.test(parts[6] + ',' + parts[7])) return false;
    if (!dateTimeRegex.test(parts[8] + ',' + parts[9])) return false;

    // Sprawdź, czy callsign (pole 10) nie zawiera tokenu
    if (parts[10].includes('TOKEN:')) return false;

    return true;
}

const feedServer = net.createServer(feedSocket => {
    logToFile(`Nowe połączenie od ${feedSocket.remoteAddress}:${feedSocket.remotePort}`);

    let buffer = Buffer.alloc(0);

    feedSocket.on('data', data => {
        buffer = Buffer.concat([buffer, data]);
        buffer = processData(buffer, feedSocket.remoteAddress);
    });

    feedSocket.on('close', () => {
        logToFile(`Połączenie zakończone z ${feedSocket.remoteAddress}:${feedSocket.remotePort}`);
    });

    feedSocket.on('error', (error) => {
        logToFile(`Błąd połączenia z ${feedSocket.remoteAddress}:${feedSocket.remotePort}: ${error.message}`);
        feedSocket.destroy();
    });
});

feedServer.on('error', (error) => {
    logToFile(`Błąd serwera feed: ${error.message}`);
});

feedServer.listen(feedPort, () => {
    logToFile(`Serwer nasłuchuje na porcie ${feedPort}`);
});

const textClients = new Set();
const binaryClients = new Set();

const textServer = net.createServer(socket => {
    logToFile(`Klient tekstowy połączony: ${socket.remoteAddress}:${socket.remotePort}`);
    textClients.add(socket);
    logToFile(`Liczba klientów tekstowych po dodaniu: ${textClients.size}`);

    socket.on('close', () => {
        logToFile(`Klient tekstowy rozłączony: ${socket.remoteAddress}:${socket.remotePort}`);
        textClients.delete(socket);
        logToFile(`Liczba klientów tekstowych po usunięciu: ${textClients.size}`);
    });

    socket.on('error', (error) => {
        logToFile(`Błąd klienta tekstowego ${socket.remoteAddress}:${socket.remotePort}: ${error.message}`);
        textClients.delete(socket);
        logToFile(`Liczba klientów tekstowych po błędzie: ${textClients.size}`);
    });
});

textServer.listen(outputPortText, '0.0.0.0', () => {
    logToFile(`Serwer tekstowy nasłuchuje na porcie ${outputPortText}`);
});

const binaryServer = net.createServer(socket => {
    logToFile(`Klient binarny połączony: ${socket.remoteAddress}:${socket.remotePort}`);
    binaryClients.add(socket);
    logToFile(`Liczba klientów binarnych po dodaniu: ${binaryClients.size}`);

    socket.on('close', () => {
        logToFile(`Klient binarny rozłączony: ${socket.remoteAddress}:${socket.remotePort}`);
        binaryClients.delete(socket);
        logToFile(`Liczba klientów binarnych po usunięciu: ${binaryClients.size}`);
    });

    socket.on('error', (error) => {
        logToFile(`Błąd klienta binarnego ${socket.remoteAddress}:${socket.remotePort}: ${error.message}`);
        binaryClients.delete(socket);
        logToFile(`Liczba klientów binarnych po błędzie: ${binaryClients.size}`);
    });
});

binaryServer.listen(outputPortBinary, '0.0.0.0', () => {
    logToFile(`Serwer binarny nasłuchuje na porcie ${outputPortBinary}`);
    console.log(`Serwer binarny nasłuchuje na porcie ${outputPortBinary}`);
});

function sendToClients(clients, data) {
    logToFile(`Próba wysłania danych do ${clients.size} klientów`);
    for (const socket of clients) {
        try {
            const success = socket.write(data);
            if (!success) {
                logToFile(`Nie udało się wysłać danych do klienta ${socket.remoteAddress}:${socket.remotePort}`);
            } else {
                logToFile(`Dane wysłane do klienta ${socket.remoteAddress}:${socket.remotePort}`);
            }
        } catch (error) {
            logToFile(`Błąd podczas wysyłania danych do klienta ${socket.remoteAddress}:${socket.remotePort}: ${error.message}`);
            clients.delete(socket);
            socket.destroy();
        }
    }
}

function sendToBinaryClients(data) {
    logToFile(`Wysyłanie danych binarnych o długości: ${data.length}`);
    logToFile(`Pierwsze 50 bajtów danych binarnych: ${data.slice(0, 50).toString('hex')}`);
    sendToClients(binaryClients, data);
}

function sendToTextClients(data) {
    logToFile(`Wysyłanie danych tekstowych o długości: ${data.length} na port ${outputPortText}`);
    logToFile(`Pierwsze 100 znaków danych tekstowych: ${data.slice(0, 100).toString()}`);
    sendToClients(textClients, data);
}

process.on('uncaughtException', (error) => {
    logToFile(`Nieoczekiwany błąd: ${error}`);
});

process.on('unhandledRejection', (reason, promise) => {
    logToFile(`Nieobsłużone odrzucenie obietnicy: ${reason}`);
});

setInterval(() => {
    logToFile(`Liczba podłączonych klientów tekstowych: ${textClients.size}`);
    logToFile(`Liczba podłączonych klientów binarnych: ${binaryClients.size}`);
}, 10000);

let totalMessages = 0;
let validMessages = 0;
let invalidMessages = 0;

setInterval(() => {
    const validPercentage = (validMessages / totalMessages * 100).toFixed(2);
    const invalidPercentage = (invalidMessages / totalMessages * 100).toFixed(2);
    logToFile(`Statystyki: Łącznie ${totalMessages} wiadomości, ${validMessages} (${validPercentage}%) poprawnych, ${invalidMessages} (${invalidPercentage}%) niepoprawnych`);
    
    // Resetuj liczniki
    totalMessages = 0;
    validMessages = 0;
    invalidMessages = 0;
}, 60000); // Raportuj co minutę