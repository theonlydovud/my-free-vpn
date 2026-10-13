import { Bot } from 'grammy';

// Глобальные настройки (можешь поменять UUID под себя)
const UUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get('Upgrade');

    // 1. Если запрос пришел от Telegram-бота (вебхук)
    if (url.pathname === '/webhook') {
      const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
      
      bot.command('start', async (ctx) => {
        const userId = ctx.from?.id.toString();
        
        // Проверка по твоему Telegram ID, чтобы чужие не юзали бота
        if (userId !== env.ADMIN_TELEGRAM_ID) {
          return ctx.reply('Доступ запрещен.');
        }

        const workerDomain = url.hostname;
        const vlessLink = `vless://${UUID}@${workerDomain}:443?encryption=none&security=tls&type=ws&host=${workerDomain}&path=%2F#MyFreeVPN`;

        await ctx.reply(
          `🚀 **Твой личный VPN готов!**\n\n` +
          `Скопируй ключ и вставь в клиент (например, FoXray):\n\n` +
          `\`\`\`\n${vlessLink}\n\`\`\`\n\n` +
          `Включай тумблер в шторке iOS и кайфуй без рекламы.`,
          { parse_mode: 'Markdown' }
        );
      });

      return await bot.handleUpdate(request);
    }

    // 2. Если это не WebSocket для VPN и не вебхук — просто отдаем заглушку
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('OK', { status: 200 });
    }

    // 3. Обработка VPN-трафика (VLESS по WebSocket)
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();
    handleVlessSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  },
};

// Логика проксирования VLESS
function handleVlessSession(webSocket) {
  let remoteSocketWrapper = { value: null };

  webSocket.addEventListener('message', async (event) => {
    const message = event.data;

    if (!remoteSocketWrapper.value) {
      try {
        const res = processVlessHeader(message);
        if (!res) {
          webSocket.close();
          return;
        }

        const { address, port, rawDataIndex } = res;
        const remoteSocket = connect({ hostname: address, port: port });
        remoteSocketWrapper.value = remoteSocket;

        remoteSocket.readable.pipeTo(new WritableStream({
          write(chunk) {
            webSocket.send(chunk);
          },
          close() {
            webSocket.close();
          },
        })).catch(() => {});

        const writer = remoteSocket.writable.getWriter();
        await writer.write(message.slice(rawDataIndex));
        writer.releaseLock();
      } catch (err) {
        webSocket.close();
      }
    } else {
      const writer = remoteSocketWrapper.value.writable.getWriter();
      await writer.write(message);
      writer.releaseLock();
    }
  });

  webSocket.addEventListener('close', () => {
    if (remoteSocketWrapper.value) {
      remoteSocketWrapper.value.close();
    }
  });
}

function processVlessHeader(buffer) {
  if (buffer.byteLength < 24) return null;
  const view = new DataView(buffer);
  
  let offset = 1 + 16 + 1;
  const addonsLength = view.getUint8(17);
  offset += addonsLength;
  
  const command = view.getUint8(offset);
  offset += 1;
  if (command !== 1) return null;

  const port = view.getUint16(offset);
  offset += 2;
  
  const addressType = view.getUint8(offset);
  offset += 1;
  
  let address = '';
  if (addressType === 1) {
    address = Array.from(new Uint8Array(buffer, offset, 4)).join('.');
    offset += 4;
  } else if (addressType === 2) {
    const domainLength = view.getUint8(offset);
    offset += 1;
    address = new TextDecoder().decode(new Uint8Array(buffer, offset, domainLength));
    offset += domainLength;
  } else if (addressType === 3) {
    address = Array.from(new Uint16Array(buffer, offset, 8)).map(b => b.toString(16)).join(':');
    offset += 16;
  }

  return { address, port, rawDataIndex: offset };
}

function connect(address) {
  // @ts-ignore
  return globalThis.connect ? globalThis.connect(address) : null;
}