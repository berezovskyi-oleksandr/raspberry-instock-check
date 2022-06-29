import fetch from 'node-fetch'
import TelegramBot from 'node-telegram-bot-api'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import HttpsProxyAgentImport from 'https-proxy-agent'
const { HttpsProxyAgent } = HttpsProxyAgentImport
import { startServer } from './server.js'

const SEARCHED_RASPBERRY_MODELS = process.env.SEARCHED_RASPBERRY_MODELS
  ? process.env.SEARCHED_RASPBERRY_MODELS.trim().toLowerCase().split(',')
  : ['*']
const CHECK_INTERVAL = process.env.CHECK_INTERVAL ? +process.env.CHECK_INTERVAL : 60_000

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!
const TELEGRAM_LIVE_STOCK_UPDATE_MESSAGE_ID = process.env.TELEGRAM_LIVE_STOCK_UPDATE_MESSAGE_ID
  ? +process.env.TELEGRAM_LIVE_STOCK_UPDATE_MESSAGE_ID
  : undefined
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID!
const USE_DIRECT_PRODUCT_LINK = process.env.USE_DIRECT_PRODUCT_LINK === '1'
const USE_CACHED_REQUEST = process.env.USE_CACHED_REQUEST === '1'
const API_RUN = process.env.API_RUN === '1'

const PROXY = process.env.PROXY

type Raspberry = {
  sku: string
  description: string
  vendor: string
  price: { value: number; display: string; currency: string }
  link: string
  lastStock: string
  available: boolean
}
type RaspberryRpilocatorModel = {
  update_t: { sort: number; display: string }
  price: { sort: number; display: string; currency: string }
  vendor: string
  sku: string
  avail: string
  link: string
  last_stock: { sort: string; display: string }
  description: string
}

let isFirstInit = true
const raspberryAvailableCache = new Map<string, Raspberry>()

// Save the sent messages to udpate them when becomes unavailable
type StockMessageContent = {
  telegramMessage: TelegramBot.Message
  raspberryAvailable: Map<string, Raspberry>
  raspberryUnavailable: Map<string, Raspberry>
}
const lastStockMessagesIds = new Map<string, number>()
const lastStockMessagesContent = new Map<number, StockMessageContent>()

const vendors = {
  'Semaf (AT)': 'semaf',
  'MC Hobby (BE)': 'mchobby',
  'Pishop (CA)': 'pishopca',
  'Pi-Shop (CH)': 'pishopch',
  'Seeedstudio (CN)': 'seeedstudio',
  'BerryBase (DE)': 'berrybase',
  'Rasppishop (DE)': 'rasppishop',
  'Welectron (DE)': 'welectron',
  'pi3g (DE)': 'pi3g',
  'Kubii (FR)': 'kubii',
  'Melopero (IT)': 'melopero',
  'Switch Science (JP)': 'switchjp',
  'Elektor (NL)': 'elektor',
  'OKDO (NL)': 'okdonl',
  'RaspberryStore (NL)': 'raspberrystore',
  'Botland (PL)': 'botland',
  'Robert Mauser (PT)': 'mauserpt',
  'electro:kit (SE)': 'electrokit',
  'Cool Components (UK)': 'coolcomp',
  'Farnell (UK)': 'farnell',
  'OKDO (UK)': 'okdouk',
  'Pimoroni (UK)': 'pimoroni',
  'Rapid (UK)': 'rapid',
  'SB Components (UK)': 'sbcomp',
  'The Pihut (UK)': 'thepihut',
  'Adafruit (US)': 'adafruit',
  'Chicago Elec. Dist. (US)': 'chicagodist',
  'Digi-Key (US)': 'digikeyus',
  'Newark (US)': 'newark',
  'OKDO (US)': 'okdous',
  'Pishop (US)': 'pishopus',
  'Sparkfun (US)': 'sparkfun',
  'Vilros (US)': 'vilros',
  'PiShop (ZA)': 'pishopza'
}

let debugRound = 0

const bot = new TelegramBot(TELEGRAM_TOKEN)
const searchedRaspberryStr =
  SEARCHED_RASPBERRY_MODELS?.[0] === '*' ? ' All' : `\n${SEARCHED_RASPBERRY_MODELS.map(x => `\`${x}\``).join('\n')}`
bot.sendMessage(
  TELEGRAM_ADMIN_CHAT_ID,
  `Bot started! ⚡` +
    `\nLooking for models SKU starting with: ${searchedRaspberryStr}` +
    (PROXY ? `\nUsing proxy: ${new URL(PROXY).hostname}:${new URL(PROXY).port}` : '') +
    `\n🌟 Star our [GitHub](https://github.com/rigwild/raspberry-instock-check)`,
  { parse_mode: 'Markdown' }
)
// .then(res => console.log(res.message_id))

const getRaspberryList = async (): Promise<RaspberryRpilocatorModel[]> => {
  if (process.env.NODE_ENV === 'test' || USE_CACHED_REQUEST) {
    // Load from file system cache instead of fetching from rpilocator
    let fileName = '_mock_fetched_data_full.json'
    if (USE_CACHED_REQUEST) fileName = './_cached_request.json'

    let filePath = new URL(fileName, import.meta.url)
    if (!existsSync(filePath)) filePath = new URL(`../${fileName}`, filePath)
    if (!existsSync(filePath))
      throw new Error('Cached request file not found! Start your other checker instance first!')

    return JSON.parse(readFileSync(filePath, { encoding: 'utf-8' })).dataOriginalFromRpilocatorApi
  }

  // Extract API token
  const reqHome = await fetch('https://rpilocator.com/', {
    headers: {
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
      'User-Agent': 'raspberry_alert telegram bot'
    },
    agent: PROXY ? new HttpsProxyAgent(PROXY) : undefined
  })
  const cookies = reqHome.headers.raw()['set-cookie'].map(x => x.split(';')[0])
  const homeHTML = await reqHome.text()
  const apiToken = homeHTML.match(/localToken="(.*?)"/)?.[1]
  if (!apiToken) throw new Error('API token not found!')

  // Fetch data
  const reqData = await fetch(
    `https://rpilocator.com/data.cfm?method=getProductTable&instock&token=${apiToken}&&_=${Date.now()}`,
    {
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        'User-Agent': 'raspberry_alert telegram bot',
        cookie: cookies.join('; ')
      },
      agent: PROXY ? new HttpsProxyAgent(PROXY) : undefined
    }
  )
  if (!reqData.ok)
    throw new Error(`Failed to fetch API data! - Status ${reqData.status}\n${(await reqData.text()).slice(0, 2000)}`)

  return ((await reqData.json()) as any).data as RaspberryRpilocatorModel[]
}

const rpilocatorApiModelMap = (raspberry: RaspberryRpilocatorModel): Raspberry => {
  const { update_t, price, vendor, sku, avail, link, last_stock, description } = raspberry
  return {
    sku,
    description,
    vendor,
    price: { value: price.sort, currency: price.currency, display: `${price.sort.toFixed(2)} ${price.currency}` },
    link,
    lastStock: last_stock.sort,
    available: avail === 'Yes'
  }
}

const updateRapsberryCache = (raspberryList: Raspberry[]) => {
  raspberryList = raspberryList.filter(r => r.available)
  if (SEARCHED_RASPBERRY_MODELS?.[0] !== '*')
    raspberryList = raspberryList.filter(r =>
      SEARCHED_RASPBERRY_MODELS.some(model => r.sku.toLowerCase().startsWith(model))
    )

  // Mock data for testing
  if (process.env.NODE_ENV === 'test') {
    const setAvailable = (index: number, status: boolean) => (_raspberryList[index].available = status)
    if (debugRound === 0) setAvailable(50, false)
    if (debugRound === 1) setAvailable(50, true)
    if (debugRound === 2) setAvailable(50, false)
    if (debugRound === 3) {
      setAvailable(25, true)
      setAvailable(50, true)
    }
    if (debugRound === 4) {
      setAvailable(25, false)
      setAvailable(50, true)
    }
    if (debugRound === 5) {
      setAvailable(25, false)
      setAvailable(50, false)
    }
  }

  const raspberryList = _raspberryList.filter(x => x.available)
  const raspberryAvailable = new Map() as typeof raspberryAvailableCache
  raspberryList.forEach(raspberry => raspberryAvailable.set(getRaspberryKey(raspberry), raspberry))

  const raspberryListWithChanges = {
    nowAvailableRaspberry: new Map() as Map<string, Raspberry>,
    nowUnavailableRaspberry: new Map() as Map<string, Raspberry>
  }

  // Do not alert on startup, only fill the cache
  if (isFirstInit) {
    ;[...raspberryAvailable.entries()].forEach(([raspberryKey, raspberry]) =>
      raspberryAvailableCache.set(raspberryKey, raspberry)
    )
    isFirstInit = false
    return raspberryListWithChanges
  }

  // Find the raspberrys that are available now but were not before
  ;[...raspberryAvailable.entries()].forEach(([raspberryKey, raspberry]) => {
    if (!raspberryAvailableCache.has(raspberryKey))
      raspberryListWithChanges.nowAvailableRaspberry.set(raspberryKey, raspberry)
  })

  // Find the raspberrys that are not available now but were before
  ;[...raspberryAvailableCache.entries()]
    .filter(([raspberryKey, raspberry]) => !raspberryAvailable.has(raspberryKey))
    .forEach(([raspberryKey, raspberry]) =>
      raspberryListWithChanges.nowUnavailableRaspberry.set(raspberryKey, raspberry)
    )

  // Update the raspberry cache
  raspberryAvailableCache.clear()
  ;[...raspberryAvailable.entries()].forEach(([raspberryKey, raspberry]) =>
    raspberryAvailableCache.set(raspberryKey, raspberry)
  )

  return raspberryListWithChanges
}

const getRaspberryLink = (r: Raspberry) => {
  let itemLink = r.link
  if (!USE_DIRECT_PRODUCT_LINK) {
    itemLink = `https://rpilocator.com/?utm_source=telegram&utm_medium=rapsberry_alert`
    if (vendors[r.vendor]) itemLink += `&vendor=${vendors[r.vendor]}`
  }
  return `[${r.description} | ${r.vendor} | ${r.price.display}](${itemLink})`
}

const getRaspberryKey = (r: Raspberry) => `${r.sku}-${r.vendor}-${r.price.display}`

const twoDigits = (serializable: any) => serializable.toString().padStart(2, '0')

/** @see https://gist.github.com/rigwild/bf712322eac2244096468985ee4a5aae */
export const toHumanDateTime = (date: Date) =>
  `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} - ${twoDigits(
    date.getHours()
  )}:${twoDigits(date.getMinutes())}`

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

  // message += `\n\nCurrently in stock:\n`
  // // Get links and remove duplicates
  // const links = new Set(raspberryAvailabilities.raspberryList.filter(r => r.available).map(r => getRaspberryLink(r)))
  // message += [...links].join('\n')

  message += '\n\n🌟 Star our [GitHub](https://github.com/rigwild/raspberry-instock-check)'
  message += `\n🌐 Stock data from [rpilocator](https://rpilocator.com/?utm_source=telegram&utm_medium=rapsberry_alert)`
  return message
}

const sendTelegramAlert = async (raspberryListWithChanges: ReturnType<typeof updateRapsberryCache>) => {
  const nowAvailableRaspberryListLastStockMessagesKeys = []
  const message = getTelegramMessage(raspberryListWithChanges, nowAvailableRaspberryListLastStockMessagesKeys)
  console.log(raspberryListWithChanges.nowAvailableRaspberry)
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
      const message_id = lastStockMessagesIds.get(raspberryKey)!
      const lastMessageContent = lastStockMessagesContent.get(message_id)!
      lastMessageContent.raspberryAvailable.delete(raspberryKey)
      lastMessageContent.raspberryUnavailable.set(raspberryKey, raspberry)
      const raspberryAvailabilities = {
        nowAvailableRaspberry: lastMessageContent.raspberryAvailable,
        nowUnavailableRaspberry: lastMessageContent.raspberryUnavailable
      }
      lastMessageContent.telegramMessage.text = getTelegramMessage(raspberryAvailabilities)
      await bot.editMessageText(lastMessageContent.telegramMessage.text, {
        chat_id: TELEGRAM_CHAT_ID,
        message_id: lastMessageContent.telegramMessage.message_id,
        parse_mode: 'Markdown'
      })
    }
  }
}

const checkStock = async () => {
  if (process.env.NODE_ENV === 'development') console.log(debugRound)

  try {
    console.log('Checking stock...')

    const raspberryListRpilocatorModel = await getRaspberryList()
    const raspberryList = raspberryListRpilocatorModel.map(rpilocatorApiModelMap)
    console.log(raspberryList)

    const raspberryListWithChanges = updateRapsberryCache(raspberryList)

    // Cache it on file system for other checker instances and API endpoint
    if (!USE_CACHED_REQUEST) {
      const apiData = {
        lastUpdate: new Date(),
        data: [...raspberryAvailableCache.values()],
        dataOriginalFromRpilocatorApi: raspberryListRpilocatorModel
      }
      writeFileSync(new URL('../_cached_request_data.json', import.meta.url), JSON.stringify(apiData, null, 2))
    }

    // console.log('nowAvailableRaspberry', raspberryListWithChanges.nowAvailableRaspberry)
    // console.log(raspberryListWithChanges)

    if (raspberryListWithChanges.nowAvailableRaspberry.size > 0) {
      await sendTelegramAlert(raspberryListWithChanges)
      if (process.env.NODE_ENV === 'development')
        writeFileSync(
          `now-available-${Date.now()}.json`,
          JSON.stringify([...raspberryAvailableCache.values()], null, 2)
        )
    } else {
      console.log('Not in stock!')
    }
    if (raspberryListWithChanges.nowUnavailableRaspberry.size > 0) {
      await updateTelegramAlert(raspberryListWithChanges)
    }
  } catch (error) {
    console.error(error)
    await bot.sendMessage(TELEGRAM_ADMIN_CHAT_ID, `❌ Error!\n\`\`\`${error.stack.slice(0, 2000)}\`\`\``, {
      parse_mode: 'Markdown'
    })
  }
  debugRound++
}

const liveStockUpdate = async () => {
  if (!TELEGRAM_LIVE_STOCK_UPDATE_MESSAGE_ID) return

  let message = '🔴🤖 Live Raspberry Stock Update\n\n'

  const available = [...new Set([...raspberryAvailableCache.values()])]
    .filter(x => x.available)
    .map(r => `✅ ${getRaspberryLink(r)}`)
  message += available.length > 0 ? available.join('\n') : '🤷‍♀️ Nothing available right now'

  message += '\n\n🌟 Star our [GitHub](https://github.com/rigwild/raspberry-instock-check)'
  message += '\n🌐 Stock data from [rpilocator](https://rpilocator.com/?utm_source=telegram&utm_medium=rapsberry_alert)'
  message += `\n\n🔄 Last update at ${toHumanDateTime(new Date())}`

  await bot
    .editMessageText(message, {
      chat_id: TELEGRAM_CHAT_ID,
      message_id: TELEGRAM_LIVE_STOCK_UPDATE_MESSAGE_ID,
      parse_mode: 'Markdown'
    })
    .catch(() => {})
}

checkStock().finally(() => {
  liveStockUpdate()
  setInterval(checkStock, CHECK_INTERVAL + Math.random() * 3000)
  setInterval(liveStockUpdate, process.env.NODE_ENV === 'test' ? 2000 : 10_000)
  if (API_RUN) startServer()
})
