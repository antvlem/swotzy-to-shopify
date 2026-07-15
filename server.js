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

    const shopifyRates = swotzyRates
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

/**
 * Преобразует один тариф Swotzy
 * в формат Shopify CarrierService.
 */
function mapSwotzyRateToShopify(
  rate,
  index,
  fallbackCurrency = 'EUR'
) {
  const carrierName =
    rate.carrier?.name ||
    rate.carrier_name ||
    rate.provider_name ||
    rate.provider ||
    'Courier';

  const serviceName =
    rate.service?.name ||
    rate.service_name ||
    rate.name ||
    rate.title ||
    'Delivery';

  const carrierCode =
    rate.carrier?.code ||
    rate.carrier?.id ||
    rate.carrier_id ||
    carrierName;

  const serviceId =
    rate.service?.code ||
    rate.service?.id ||
    rate.service_id ||
    rate.id ||
    index + 1;

  const price = extractPrice(rate);

  if (!Number.isFinite(price)) {
    console.error('Invalid Swotzy rate price:', rate);
    return null;
  }

  return {
    service_name: `${carrierName} — ${serviceName}`,

    service_code: createServiceCode(
      `${carrierCode}_${serviceId}`,
      index
    ),

    description:
      rate.description ||
      rate.delivery_time ||
      rate.estimated_delivery ||
      'Delivery through Swotzy',

    total_price: String(
      Math.round(price * 100)
    ),

    currency: String(
      rate.currency ||
      rate.price?.currency ||
      fallbackCurrency
    ).toUpperCase(),
  };
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