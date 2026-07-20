import 'dotenv/config';
import express from 'express';
import { Buffer } from 'node:buffer';

const app = express();

app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 3000;

const SWOTZY_API_URL =
  process.env.SWOTZY_API_URL?.trim() ||
  'https://api.swotzy.com/public/rates';

const SWOTZY_PUBLIC_KEY =
  process.env.SWOTZY_PUBLIC_KEY?.trim();

const SWOTZY_PRIVATE_KEY =
  process.env.SWOTZY_PRIVATE_KEY?.trim();

/*
 * Временно используем стандартные размеры упаковки.
 * Потом их можно брать из metafields Shopify
 * или рассчитывать в зависимости от товаров.
 *
 * Предполагаемые единицы — сантиметры.
 */
const DEFAULT_PACKAGE = {
  length: 30,
  width: 20,
  height: 10,
};

/**
 * Проверка, что сервер работает.
 */
app.get('/', (req, res) => {
  return res
    .status(200)
    .send('Shopify Swotzy server is running');
});

/**
 * Endpoint для Shopify CarrierService.
 *
 * Сейчас его можно тестировать через Postman:
 * POST http://localhost:3000/shipping-rates
 */
app.post('/shipping-rates', async (req, res) => {
  try {
    const shopifyRate = req.body?.rate;

    if (!shopifyRate) {
      return res.status(400).json({
        error: 'Missing rate object',
      });
    }

    if (!SWOTZY_PUBLIC_KEY || !SWOTZY_PRIVATE_KEY) {
      console.error(
        'SWOTZY_PUBLIC_KEY or SWOTZY_PRIVATE_KEY is missing'
      );

      return res.status(500).json({
        error: 'Swotzy credentials are not configured',
      });
    }

    if (!shopifyRate.origin) {
      return res.status(400).json({
        error: 'Origin address is missing',
      });
    }

    if (!shopifyRate.destination) {
      return res.status(400).json({
        error: 'Destination address is missing',
      });
    }

    const totalWeightGrams = calculateTotalWeight(
      shopifyRate.items
    );

    if (totalWeightGrams <= 0) {
      console.error(
        'Invalid shipment weight:',
        totalWeightGrams
      );

      /*
       * Если у заказа нет корректного веса,
       * не показываем способы доставки.
       */
      return res.status(200).json({
        rates: [],
      });
    }

    /*
     * Swotzy уже сообщил в ответе 422,
     * что верхний уровень должен содержать:
     *
     * sender_address
     * shipments
     *
     * Точная структура вложенных полей может потребовать
     * корректировки после следующего ответа Swotzy.
     */
    const swotzyPayload = {
      sender_address: mapAddress(
        shopifyRate.origin,
        'Store',
        process.env.SENDER_PHONE
      ),

      recipient_address: mapAddress(
        shopifyRate.destination,
        'Customer',
        process.env.DEFAULT_RECIPIENT_PHONE
      ),

      currency: shopifyRate.currency || 'EUR',

      shipments: [
        {
          package: {
            /*
            * Shopify передаёт граммы.
            * Swotzy, судя по опубликованному примеру,
            * принимает вес в килограммах.
            */
            weight: totalWeightGrams / 1000,

            length: DEFAULT_PACKAGE.length,
            width: DEFAULT_PACKAGE.width,
            height: DEFAULT_PACKAGE.height,
          },
        },
      ],
    };

    console.log('\n====================================');
    console.log('Request received:');
    console.dir(req.body, {
      depth: null,
    });

    console.log('\nPayload sent to Swotzy:');
    console.dir(swotzyPayload, {
      depth: null,
    });

    console.log('\nSwotzy configuration:');
    console.log({
      url: SWOTZY_API_URL,
      hasPublicKey: Boolean(SWOTZY_PUBLIC_KEY),
      publicKeyLength: SWOTZY_PUBLIC_KEY?.length,
      hasPrivateKey: Boolean(SWOTZY_PRIVATE_KEY),
      privateKeyLength: SWOTZY_PRIVATE_KEY?.length,
    });

    /*
     * Формируем Basic Auth:
     *
     * public_key:private_key
     * ↓
     * Base64
     */
    const credentials = Buffer.from(
      `${SWOTZY_PUBLIC_KEY}:${SWOTZY_PRIVATE_KEY}`,
      'utf8'
    ).toString('base64');

    const controller = new AbortController();

    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 7000);

    let swotzyResponse;

    try {
      swotzyResponse = await fetch(
        SWOTZY_API_URL,
        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Basic ${credentials}`,
          },

          body: JSON.stringify(swotzyPayload),

          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const responseText =
      await swotzyResponse.text();

    const swotzyData =
      safeJsonParse(responseText);

    console.log('\nSwotzy status:');
    console.log(swotzyResponse.status);

    console.log('\nSwotzy response:');
    console.dir(
      swotzyData ?? responseText,
      {
        depth: null,
      }
    );

    /*
     * Swotzy вернул ошибку.
     *
     * Во время разработки возвращаем её в Postman,
     * чтобы видеть недостающие поля.
     */
    if (!swotzyResponse.ok) {
      return res.status(502).json({
        error: 'Swotzy API request failed',
        swotzyStatus: swotzyResponse.status,
        swotzyResponse:
          swotzyData ?? responseText,
      });
    }

    /*
     * После успешного ответа пытаемся найти
     * массив тарифов в ответе Swotzy.
     */
    const swotzyRates =
      extractSwotzyRates(swotzyData);

    if (!swotzyRates.length) {
      return res.status(502).json({
        error:
          'Swotzy returned a successful response, but rates were not recognized',

        /*
         * Это позволит увидеть точную структуру
         * успешного ответа Swotzy в Postman.
         */
        swotzyResponse: swotzyData,
      });
    }

    const destinationCountry =
      shopifyRate.destination.country ||
      shopifyRate.destination.country_code ||
      '';

    const shopifyRates = swotzyRates
      .filter((rate) => {
        const allowed = shouldReturnSwotzyRate(
          rate,
          destinationCountry
        );

        if (!allowed) {
          console.log('Swotzy rate filtered:', {
            country: destinationCountry,
            carrier: getSwotzyCarrier(rate),
            service: getSwotzyService(rate),
          });
        }

        return allowed;
      })
      .map((rate, index) => {
        return mapSwotzyRateToShopify(
          rate,
          index,
          shopifyRate.currency
        );
      })
      .filter(Boolean);

    console.log('\nRates returned to Shopify:');
    console.dir(shopifyRates, {
      depth: null,
    });

    return res.status(200).json({
      rates: shopifyRates,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      console.error(
        'Swotzy request timed out'
      );

      return res.status(504).json({
        error: 'Swotzy API request timed out',
      });
    }

    console.error(
      'Shipping rates server error:'
    );

    console.error(error);

    return res.status(500).json({
      error: 'Internal server error',
      message: error?.message,
    });
  }
});

/**
 * Считает общий вес всех товаров.
 *
 * Shopify передаёт вес одной единицы
 * товара в поле grams.
 */
function calculateTotalWeight(items = []) {
  if (!Array.isArray(items)) {
    return 0;
  }

  return items.reduce((total, item) => {
    if (item?.requires_shipping === false) {
      return total;
    }

    const grams = Number(item?.grams) || 0;
    const quantity =
      Number(item?.quantity) || 0;

    return total + grams * quantity;
  }, 0);
}

/**
 * Преобразует адрес Shopify
 * в предполагаемый формат Swotzy.
 *
 * Если Swotzy вернёт новую ошибку 422,
 * корректировать нужно будет эту функцию.
 */
function mapAddress(
  address = {},
  fallbackName = 'Customer',
  fallbackPhone = ''
) {
  const fullName =
    address.name ||
    [address.first_name, address.last_name]
      .filter(Boolean)
      .join(' ') ||
    address.company_name ||
    fallbackName;

  return {
    full_name: fullName,

    company:
      address.company_name ||
      undefined,

    contact_name: fullName,

    phone:
      address.phone ||
      fallbackPhone ||
      '+37100000000',

    email:
      address.email ||
      undefined,

    address1:
      address.address1 ||
      '',

    address2:
      address.address2 ||
      undefined,

    zip:
      address.postal_code ||
      address.zip ||
      '',

    city:
      address.city ||
      '',

    state:
      address.province ||
      address.state ||
      undefined,

    country:
      address.country ||
      address.country_code ||
      '',
  };
}

/**
 * Безопасно преобразует текст в JSON.
 */
function safeJsonParse(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Ищет тарифы в разных возможных
 * местах ответа Swotzy.
 *
 * После первого ответа 200 можно будет
 * оставить только точное поле.
 */
function extractSwotzyRates(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (!data || typeof data !== 'object') {
    return [];
  }

  const possibleFields = [
    'rates',
    'shipping_rates',
    'shippingRates',
    'offers',
    'services',
    'options',
    'results',
    'items',
  ];

  for (const field of possibleFields) {
    if (Array.isArray(data[field])) {
      return data[field];
    }
  }

  if (
    data.data &&
    typeof data.data === 'object'
  ) {
    return extractSwotzyRates(data.data);
  }

  return [];
}

const EU_COUNTRY_CODES = new Set([
  'AT', // Austria
  'BE', // Belgium
  'BG', // Bulgaria
  'HR', // Croatia
  'CY', // Cyprus
  'CZ', // Czechia
  'DK', // Denmark
  'EE', // Estonia
  'FI', // Finland
  'FR', // France
  'DE', // Germany
  'GR', // Greece
  'HU', // Hungary
  'IE', // Ireland
  'IT', // Italy
  'LV', // Latvia
  'LT', // Lithuania
  'LU', // Luxembourg
  'MT', // Malta
  'NL', // Netherlands
  'PL', // Poland
  'PT', // Portugal
  'RO', // Romania
  'SK', // Slovakia
  'SI', // Slovenia
  'ES', // Spain
  'SE', // Sweden
]);

const BLOCKED_SWOTZY_CARRIERS = new Set([
  'QWQER',
]);

function normalizeRateValue(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function getSwotzyCarrier(rate = {}) {
  return normalizeRateValue(
    typeof rate.carrier === 'string'
      ? rate.carrier
      : rate.carrier?.name
  );
}

function getSwotzyService(rate = {}) {
  const service =
    typeof rate.service === 'string'
      ? rate.service
      : rate.service?.name;

  return normalizeRateValue(
    [
      service,
      rate.name,
      rate.service_name,
      rate.serviceName,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function shouldReturnSwotzyRate(
  rate = {},
  destinationCountry = ''
) {
  const countryCode = String(destinationCountry)
    .trim()
    .toUpperCase();

  const carrier = getSwotzyCarrier(rate);
  const service = getSwotzyService(rate);

  if (BLOCKED_SWOTZY_CARRIERS.has(carrier)) {
    return false;
  }

  if (carrier.includes('DHL EXPRESS')) {
    return true;
  }

  if (carrier.includes('OMNIVA')) {
    const isEU = EU_COUNTRY_CODES.has(countryCode);

    const isPremium =
      service.includes('PREMIUM');

    const isStandard =
      service.includes('STANDARD');

    if (isEU) {
      /*
       * В ЕС оставляем все тарифы Omniva,
       * кроме тех, которые позже явно запретим.
       */
      return true;
    }

    /*
     * За пределами ЕС — только Premium.
     */
    return isPremium;
  }

  return true;
}

function getNormalizedCarrierName(rate = {}) {
  const carrier =
    typeof rate.carrier === 'string'
      ? rate.carrier
      : rate.carrier?.name;

  return String(carrier || '')
    .trim()
    .toUpperCase();
}

function isBlockedSwotzyRate(rate = {}) {
  const carrier =
    getNormalizedCarrierName(rate);

  return BLOCKED_SWOTZY_CARRIERS.has(
    carrier
  );
}

function getCarrierName(rate = {}) {
  const possibleNames = [
    typeof rate.carrier === 'string'
      ? rate.carrier
      : rate.carrier?.name,

    typeof rate.courier === 'string'
      ? rate.courier
      : rate.courier?.name,

    typeof rate.provider === 'string'
      ? rate.provider
      : rate.provider?.name,

    rate.carrier_name,
    rate.carrierName,

    rate.courier_name,
    rate.courierName,

    rate.provider_name,
    rate.providerName,

    rate.company_name,
    rate.companyName,

    rate.delivery_company,
    rate.deliveryCompany,

    rate.service?.carrier?.name,
    rate.service?.courier?.name,
  ];

  return (
    possibleNames.find(
      (value) =>
        typeof value === 'string' &&
        value.trim()
    )?.trim() || 'Courier'
  );
}

function getRateDescription(rate = {}) {
  const possibleDescriptions = [
    rate.description,

    rate.service_description,
    rate.serviceDescription,
    rate.service?.description,

    rate.delivery_time,
    rate.deliveryTime,
    rate.service?.delivery_time,
    rate.service?.deliveryTime,

    rate.estimated_delivery,
    rate.estimatedDelivery,
    rate.estimated_delivery_time,
    rate.estimatedDeliveryTime,

    rate.transit_time,
    rate.transitTime,
    rate.service?.transit_time,
    rate.service?.transitTime,

    rate.eta,
  ];

  const description = possibleDescriptions.find(
    value =>
      typeof value === 'string' &&
      value.trim()
  );

  if (description) {
    return description.trim();
  }

  const deliveryDays =
    rate.delivery_days ??
    rate.deliveryDays ??
    rate.transit_days ??
    rate.transitDays ??
    rate.service?.delivery_days ??
    rate.service?.deliveryDays;

  if (Number.isFinite(Number(deliveryDays))) {
    const days = Number(deliveryDays);

    return `Estimated delivery: ${days} business ${
      days === 1 ? 'day' : 'days'
    }`;
  }

  const minDays = Number(
    rate.min_delivery_days ??
    rate.minDeliveryDays ??
    rate.delivery_days_min ??
    rate.transit_days_min ??
    rate.service?.min_delivery_days
  );

  const maxDays = Number(
    rate.max_delivery_days ??
    rate.maxDeliveryDays ??
    rate.delivery_days_max ??
    rate.transit_days_max ??
    rate.service?.max_delivery_days
  );

  if (
    Number.isFinite(minDays) &&
    Number.isFinite(maxDays)
  ) {
    if (minDays === maxDays) {
      return `Estimated delivery: ${minDays} business ${
        minDays === 1 ? 'day' : 'days'
      }`;
    }

    return `Estimated delivery: ${minDays}–${maxDays} business days`;
  }

  return 'Delivery through Swotzy';
}

function toShopifyDeliveryDate(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return null;
  }

  /*
   * Swotzy возвращает только дату.
   * Добавляем время и UTC-смещение
   * в формате, который принимает Shopify.
   */
  return `${value} 12:00:00 +0000`;
}

function formatDeliveryDate(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return null;
  }

  const [year, month, day] = value.split('-');

  return `${day}.${month}.${year}`;
}

function getDeliveryEstimateDescription(rate = {}) {
  const fromDate = formatDeliveryDate(
    rate.delivery_estimate?.from_date
  );

  const toDate = formatDeliveryDate(
    rate.delivery_estimate?.to_date
  );

  if (fromDate && toDate) {
    if (fromDate === toDate) {
      return `Estimated delivery: ${fromDate}`;
    }

    return `Estimated delivery: ${fromDate}–${toDate}`;
  }

  if (fromDate) {
    return `Estimated delivery from ${fromDate}`;
  }

  if (toDate) {
    return `Estimated delivery by ${toDate}`;
  }

  return '';
}

/**
 * Преобразует один тариф Swotzy
 * в формат Shopify CarrierService.
 */
function mapSwotzyRateToShopify(
  rate,
  index,
  fallbackCurrency = 'EUR'
) {
  const carrierName = getCarrierName(rate);

  const serviceName =
    rate.service?.name ||
    rate.service_name ||
    rate.serviceName ||
    rate.name ||
    rate.title ||
    `Delivery ${index + 1}`;

  const serviceId =
    rate.service?.id ||
    rate.service?.code ||
    rate.service_id ||
    rate.serviceId ||
    rate.id ||
    index + 1;

  const carrierId =
    rate.carrier?.id ||
    rate.carrier?.code ||
    rate.carrier_id ||
    rate.carrierId ||
    rate.courier?.id ||
    rate.courier?.code ||
    carrierName;

  const price = extractPrice(rate);

  if (!Number.isFinite(price)) {
    console.error(
      'Invalid Swotzy rate price:',
      rate
    );

    return null;
  }

  const minDeliveryDate =
    toShopifyDeliveryDate(
      rate.delivery_estimate?.from_date
    );

  const maxDeliveryDate =
    toShopifyDeliveryDate(
      rate.delivery_estimate?.to_date
    );

  const shopifyRate = {
    service_name: `${carrierName} — ${serviceName}`,

    service_code: createServiceCode(
      `${carrierId}_${serviceId}`,
      index
    ),

    description: getDeliveryEstimateDescription(rate),

    total_price: String(
      Math.round(price * 100)
    ),

    currency: String(
      rate.currency ||
        rate.price?.currency ||
        fallbackCurrency ||
        'EUR'
    ).toUpperCase(),
  };

  if (minDeliveryDate) {
    shopifyRate.min_delivery_date =
      minDeliveryDate;
  }

  if (maxDeliveryDate) {
    shopifyRate.max_delivery_date =
      maxDeliveryDate;
  }

  return shopifyRate;
}

/**
 * Ищет цену в различных
 * возможных форматах ответа Swotzy.
 */
function extractPrice(rate = {}) {
  const values = [
    rate.price?.amount,
    rate.total?.amount,
    rate.price,
    rate.total_price,
    rate.totalPrice,
    rate.amount,
    rate.cost,
    rate.gross_price,
    rate.grossPrice,
  ];

  for (const value of values) {
    const number = Number(value);

    if (Number.isFinite(number)) {
      return number;
    }
  }

  return null;
}

/**
 * Создаёт стабильный код доставки,
 * если Swotzy не предоставил свой.
 */
function createServiceCode(
  serviceName,
  index
) {
  const slug = String(serviceName)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return (
    slug ||
    `swotzy_delivery_${index + 1}`
  );
}

app.listen(PORT, () => {
  console.log(
    `Server started on port ${PORT}`
  );
});