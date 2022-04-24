// @ts-check
import fetch from 'node-fetch'
import { JSDOM } from 'jsdom'
import TelegramBot from 'node-telegram-bot-api'

const STOCK_URI = 'https://rpilocator.com/'
const SEARCHED_RASPBERRY_MODELS = process.env.SEARCHED_RASPBERRY_MODELS
  ? process.env.SEARCHED_RASPBERRY_MODELS.split(',')
  : ['*']
const CHECK_INTERVAL = process.env.CHECK_INTERVAL ? +process.env.CHECK_INTERVAL : 60_000

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID!
const USE_DIRECT_PRODUCT_LINK = process.env.USE_DIRECT_PRODUCT_LINK === '1'

type Raspberry = {
  sku: string
  description: string
  vendor: string
  price: string
  link: string
  lastStock: string
  available: boolean
}

const rapsberryListCache = new Map<string, Raspberry>()

// Used to get the vendor id from the vendor name for the product link with query string filter
// key=vendor.name, value=vendor.id
const vendorsCache = new Map<string, string>()

// Save the sent messages to udpate them when becomes unavailable
type StockMessageContent = {
  telegramMessage: TelegramBot.Message
  raspberryAvailable: Map<string, Raspberry>
  raspberryUnavailable: Map<string, Raspberry>
}
const lastStockMessagesIds = new Map<string, number>()
const lastStockMessagesContent = new Map<number, StockMessageContent>()

let debugRound = 0

const bot = new TelegramBot(TELEGRAM_TOKEN)
bot.sendMessage(
  TELEGRAM_ADMIN_CHAT_ID,
  `Bot started! ⚡ Looking for models:${
    SEARCHED_RASPBERRY_MODELS?.[0] === '*' ? ' All' : '\n' + SEARCHED_RASPBERRY_MODELS.map(x => `\`${x}\``).join('\n')
  }\nhttps://github.com/rigwild/raspberry-instock-check`,
  { parse_mode: 'Markdown' }
)

const getHTML = async () => {
  const rawHTML = await fetch(STOCK_URI).then(res => res.text())
  const dom = new JSDOM(rawHTML)
  return dom.window.document
}

const parseHTMLGetRaspberryList = (document: Document): Raspberry[] => {
  const raspberryList: Raspberry[] = [...document.querySelectorAll('tr')]
    .slice(1)
    .map(x => [x.querySelector('th'), ...x.querySelectorAll('td')])
    .map(trRows => {
      const raspberry: Raspberry = {
        sku: trRows[0]!.textContent!.trim(),
        description: trRows[1]!.textContent!.trim(),
        link: trRows[2]!.querySelector('a')?.href!,
        vendor: trRows[4]!.textContent!.trim(),
        available: trRows[5]!.textContent!.trim().toLowerCase() === 'yes',
        lastStock: trRows[6]!.textContent!.trim(),
        price: trRows[7]!.textContent!.trim()
      }
      return raspberry
    })
  return SEARCHED_RASPBERRY_MODELS?.[0] === '*'
    ? raspberryList
    : raspberryList.filter(x => SEARCHED_RASPBERRY_MODELS.includes(x.sku))
}

const updateRapsberryCache = (document: Document) => {
  const raspberryList = parseHTMLGetRaspberryList(document)

  // Testing
  if (process.env.NODE_ENV === 'development') {
    const keys = [...rapsberryListCache.keys()]
    if (debugRound === 1) {
      raspberryList.find(x => getRaspberryKey(x) === keys[50])!.available = true
    }
    if (debugRound === 2) {
      raspberryList.find(x => getRaspberryKey(x) === keys[50])!.available = false
    }
    if (debugRound === 3) {
      raspberryList.find(x => getRaspberryKey(x) === keys[25])!.available = true
      raspberryList.find(x => getRaspberryKey(x) === keys[50])!.available = true
    }
    if (debugRound === 4) {
      raspberryList.find(x => getRaspberryKey(x) === keys[25])!.available = false
      raspberryList.find(x => getRaspberryKey(x) === keys[50])!.available = true
    }
    if (debugRound === 5) {
      raspberryList.find(x => getRaspberryKey(x) === keys[25])!.available = false
      raspberryList.find(x => getRaspberryKey(x) === keys[50])!.available = false
    }
    debugRound++
  }

  let isFirstInit = rapsberryListCache.size === 0
  const nowAvailableRaspberry: Map<string, Raspberry> = new Map()
  const nowUnavailableRaspberry: Map<string, Raspberry> = new Map()
  const raspberryListWithChanges = {
    raspberryList,
    nowAvailableRaspberry,
    nowUnavailableRaspberry
  }

  raspberryList.forEach(raspberry => {
    const raspberryKey = getRaspberryKey(raspberry)
    if (isFirstInit) {
      rapsberryListCache.set(raspberryKey, raspberry)
      // Do not notify on startup
      // if (raspberry.available) nowAvailableRaspberryList.push(raspberry)
      return
    }

    const cachedRaspberry = rapsberryListCache.get(raspberryKey)

    // New Raspberry listing appeared on rpilocator.com
    if (!cachedRaspberry) {
      rapsberryListCache.set(raspberryKey, raspberry)
      if (raspberry.available) nowAvailableRaspberry.set(raspberryKey, raspberry)
      return
    }

    // Alert if the raspberry is now available but was not before
    if (raspberry.available && !cachedRaspberry.available) {
      nowAvailableRaspberry.set(raspberryKey, raspberry)
    }
    // Alert if the raspberry is now unavailable but was before
    if (!raspberry.available && cachedRaspberry.available) {
      nowUnavailableRaspberry.set(raspberryKey, raspberry)
    }

    rapsberryListCache.set(raspberryKey, raspberry)
  })

  if (isFirstInit) isFirstInit = false

  return raspberryListWithChanges
}

const updateVendorsCache = (document: Document) => {
  ;[...document.querySelectorAll('a[data-vendor]')]
    .map(x => {
      const [country, ...vendorName] = x.textContent!.trim().split(' ')
      return {
        id: x.getAttribute('data-vendor'),
        name: `${vendorName.join(' ')} ${country}`.trim()
      }
    })
    .forEach(({ id, name }) => vendorsCache.set(name, id))
  vendorsCache.delete('All')
}

const getRaspberryLink = (r: Raspberry) => {
  let itemLink: string
  let urlQueries: Array<[string, string]> = []
  if (USE_DIRECT_PRODUCT_LINK) itemLink = r.link
  else {
    itemLink = STOCK_URI
    if (vendorsCache.has(r.vendor)) urlQueries.push(['vendor', vendorsCache.get(r.vendor)])
  }
  urlQueries.push(['utm_source', 'telegram'])
  urlQueries.push(['utm_medium', 'rapsberry_alert'])
  itemLink += '?' + urlQueries.map(([k, v]) => `${k}=${v}`).join('&')
  return `[${r.description} | ${r.vendor} | ${r.price}](${itemLink})`
}

const getRaspberryKey = (r: Raspberry) => `${r.sku}-${r.vendor}-${r.price}`

const getTelegramMessage = (
  raspberryAvailabilities: ReturnType<typeof updateRapsberryCache>,
  nowAvailableRaspberryListLastStockMessagesKeys?: string[]
) => {
  let message = '🛍️ Raspberry stock changes!'

  if (raspberryAvailabilities.nowAvailableRaspberry.size > 0) {
    message += `\n\nNew Raspberry in stock! 🔥🔥\n`
    message += [...raspberryAvailabilities.nowAvailableRaspberry.values()]
      .map(r => {
        const raspberryKey = getRaspberryKey(r)
        if (nowAvailableRaspberryListLastStockMessagesKeys) {
          nowAvailableRaspberryListLastStockMessagesKeys.push(raspberryKey)
        }
        return `✅ ${getRaspberryLink(r)}`
      })
      .join('\n')
  }

  if (raspberryAvailabilities.nowUnavailableRaspberry.size > 0) {
    message += `\n\nNow out of stock! 😔\n`
    message += [...raspberryAvailabilities.nowUnavailableRaspberry.values()]
      .map(r => `❌ ${getRaspberryLink(r)}`)
      .join('\n')
  }

  message += `\n\nCurrently in stock:\n`
  message += raspberryAvailabilities.raspberryList
    .filter(r => r.available)
    .map(r => getRaspberryLink(r))
    .join('\n')

  message += `\n\nStock data from [rpilocator.com](${STOCK_URI}?utm_source=telegram&utm_medium=rapsberry_alert)`
  return message
}

const sendTelegramAlert = async (raspberryListWithChanges: ReturnType<typeof updateRapsberryCache>) => {
  const nowAvailableRaspberryListLastStockMessagesKeys = []
  const message = getTelegramMessage(raspberryListWithChanges, nowAvailableRaspberryListLastStockMessagesKeys)
  console.log(message)

  const sentMsg = await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' })

  // Record the message to update it later
  nowAvailableRaspberryListLastStockMessagesKeys.forEach(raspberryKey => {
    const raspberryAvailable = new Map()
    raspberryListWithChanges.nowAvailableRaspberry.forEach(raspberry => {
      raspberryAvailable.set(raspberryKey, raspberry)
    })

    const messageContent = {
      telegramMessage: sentMsg,
      raspberryAvailable,
      raspberryUnavailable: new Map()
    }
    lastStockMessagesIds.set(raspberryKey, sentMsg.message_id)
    lastStockMessagesContent.set(sentMsg.message_id, messageContent)

    // Delete key in 24 hours
    setTimeout(() => {
      lastStockMessagesIds.delete(raspberryKey)
      lastStockMessagesContent.delete(sentMsg.message_id)
    }, 24 * 60 * 60 * 1000)
  })
}

const updateTelegramAlert = async (raspberryListWithChanges: ReturnType<typeof updateRapsberryCache>) => {
  for (const raspberry of raspberryListWithChanges.nowUnavailableRaspberry.values()) {
    const raspberryKey = getRaspberryKey(raspberry)
    if (lastStockMessagesIds.has(raspberryKey)) {
      console.log(`Now unavailable: ${raspberryKey}`)
      const message_id = lastStockMessagesIds.get(raspberryKey)
      const lastMessageContent = lastStockMessagesContent.get(message_id)
      lastMessageContent.raspberryAvailable.delete(raspberryKey)
      lastMessageContent.raspberryUnavailable.set(raspberryKey, raspberry)
      const raspberryAvailabilities = {
        raspberryList: raspberryListWithChanges.raspberryList,
        nowAvailableRaspberry: lastMessageContent.raspberryAvailable,
        nowUnavailableRaspberry: lastMessageContent.raspberryUnavailable
      }
      lastMessageContent.telegramMessage.text = getTelegramMessage(raspberryAvailabilities)
      await bot.editMessageText(lastMessageContent.telegramMessage.text, {
        message_id: lastMessageContent.telegramMessage.message_id,
        chat_id: TELEGRAM_CHAT_ID,
        parse_mode: 'Markdown'
      })
    }
  }
}

const checkStock = async () => {
  try {
    console.log('Checking stock...')
    const document = await getHTML()

    updateVendorsCache(document)
    const raspberryListWithChanges = updateRapsberryCache(document)
    // console.log(raspberryListWithChanges)

    if (raspberryListWithChanges.nowAvailableRaspberry.size > 0) {
      await sendTelegramAlert(raspberryListWithChanges)
    } else {
      console.log('Not in stock!')
    }
    if (raspberryListWithChanges.nowUnavailableRaspberry.size > 0) {
      await updateTelegramAlert(raspberryListWithChanges)
    }
  } catch (error) {
    console.error(error)
    await bot.sendMessage(TELEGRAM_ADMIN_CHAT_ID, `❌ Error!\n${error.message}\n${error.stack}`, {
      parse_mode: 'Markdown'
    })
  }
}

checkStock()
setInterval(checkStock, CHECK_INTERVAL)
