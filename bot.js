require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const moment = require('moment'); // Удобно для работы с датами, ставь через npm i moment

const HOURS = Array.from({ length: 12 }, (_, i) => 8 + i);
const token = process.env.BOT_TOKEN;
const adminId = process.env.ADMIN_CHAT_ID;
const bot = new TelegramBot(token, { polling: true });


const bookingsDir = path.join(__dirname, 'data');
const bookingsPath = path.join(bookingsDir, 'bookings.json');

const getNext7Days = () => {
	const days = [];
	for (let i = 0; i < 7; i++) {
		const day = moment().add(i, 'days');
		days.push({
			display: day.format('D MMMM'), // "8 июня"
			key: day.format('YYYY-MM-DD')  // "2025-06-08"
		});
	}
	return days;
};
// Создаём папку data, если нет
if (!fs.existsSync(bookingsDir)) {
	fs.mkdirSync(bookingsDir, { recursive: true });
	console.log('Папка data создана');
}

const loadBookings = () => {
	if (!fs.existsSync(bookingsPath)) {
		console.log('Файл бронирований не найден, возвращаем пустой объект');
		return {};
	}
	try {
		const data = JSON.parse(fs.readFileSync(bookingsPath, 'utf-8'));
		console.log('Загружены брони:', data);
		return data;
	} catch (err) {
		console.error('Ошибка при чтении файла бронирований:', err);
		return {};
	}
};

const saveBookings = (data) => {
	console.log('Сохраняем брони:', data);
	try {
		fs.writeFileSync(bookingsPath, JSON.stringify(data, null, 2));
	} catch (err) {
		console.error('Ошибка записи бронирований:', err);
	}
};


// Команда /start
bot.onText(/\/start/, (msg) => {
	const chatId = msg.chat.id;
	bot.sendMessage(chatId, 'Привет! Нажми кнопку, чтобы записаться на теннис.', {
		reply_markup: {
			keyboard: [['🎾 Записаться', '📋 Мои брони']],
			resize_keyboard: true
		}
	});
});


// Кнопка "Записаться"
bot.on('message', (msg) => {
	if (msg.text === '🎾 Записаться') {
		const days = getNext7Days();
		bot.sendMessage(msg.chat.id, 'Выбери дату:', {
			reply_markup: {
				inline_keyboard: days.map(d => [{
					text: d.display,
					callback_data: `date_${d.key}`
				}])
			}
		});
	}
	if (msg.text === '📋 Мои брони') {
		const chatId = msg.chat.id;
		const userId = msg.from.id;

		const bookings = loadBookings();
		const userBookings = Object.entries(bookings)
			.filter(([_, users]) => users.some(u => u.id === userId));

		if (userBookings.length === 0) {
			bot.sendMessage(chatId, 'У вас нет активных броней.');
			return;
		}

		userBookings.forEach(([slotKey, users]) => {
			const timeStr = slotKey.replace(' ', ' в ');
			bot.sendMessage(chatId, `📅 ${timeStr}`, {
				reply_markup: {
					inline_keyboard: [[
						{
							text: '❌ Отменить',
							callback_data: `cancel_${slotKey}`
						}
					]]
				}
			});
		});
	}

});

// Обработка выбора даты
bot.on('callback_query', (query) => {
	const chatId = query.message.chat.id;
	const user = query.from;
	const data = query.data;

	if (data.startsWith('date_')) {
		const date = data.replace('date_', '');
		const bookings = loadBookings();

		// Ключи всех занятых слотов для этой даты
		const bookedSlots = Object.keys(bookings)
			.filter(slotKey => slotKey.startsWith(date))
			.map(slotKey => slotKey.split(' ')[1]); // достаём время из "YYYY-MM-DD HH:mm"

		// Формируем кнопки только для свободных слотов
		const now = moment();
		const selectedDay = moment(date, 'YYYY-MM-DD');

		const timeButtons = HOURS
			.filter(h => {
				const hourStr = h.toString().padStart(2, '0') + ':00';

				// Если день сегодня — фильтруем по текущему времени
				if (selectedDay.isSame(now, 'day')) {
					if (h <= now.hour()) return false; // прошлое время — не показываем
				}

				// Убираем уже забронированные
				return !bookedSlots.includes(hourStr);
			})
			.map(h => {
				const hourStr = h.toString().padStart(2, '0') + ':00';
				return [{
					text: hourStr,
					callback_data: `book_${date}_${hourStr}`
				}];
			});


		if (timeButtons.length === 0) {
			bot.sendMessage(chatId, `Все слоты на ${date} заняты. Выберите другую дату.`);
		} else {
			bot.sendMessage(chatId, `Выбери время для ${date}:`, {
				reply_markup: { inline_keyboard: timeButtons }
			});
		}
	}


	// При выборе времени — записываем
	if (data.startsWith('book_')) {
		const [_, date, time] = data.split('_'); // разбираем 'book_2025-06-08_08:00'

		const bookings = loadBookings();
		const slotKey = `${date} ${time}`;

		if (!bookings[slotKey]) bookings[slotKey] = [];

		const alreadyBooked = bookings[slotKey].some(u => u.id === user.id);
		if (alreadyBooked) {
			bot.answerCallbackQuery(query.id, { text: 'Вы уже записаны на этот слот.' });
			return;
		}

		bookings[slotKey].push({
			id: user.id,
			name: `${user.first_name} ${user.last_name || ''}`.trim(),
			username: user.username
		});

		saveBookings(bookings);

		bot.sendMessage(chatId, `✅ Вы записаны на ${date} в ${time}!`);
		bot.sendMessage(adminId, `🎾 Новая бронь:\n📅 ${date}\n⏰ ${time}\n👤 ${user.first_name} (@${user.username})`);

		bot.answerCallbackQuery(query.id);
	}
	if (data.startsWith('cancel_')) {
		const slotKey = data.replace('cancel_', '');
		const bookings = loadBookings();

		if (!bookings[slotKey]) {
			bot.answerCallbackQuery(query.id, { text: 'Этот слот уже пуст.' });
			return;
		}

		// Удаляем пользователя из слота
		bookings[slotKey] = bookings[slotKey].filter(u => u.id !== user.id);

		// Если слот стал пустой — удалим вообще
		if (bookings[slotKey].length === 0) {
			delete bookings[slotKey];
		}

		saveBookings(bookings);

		bot.sendMessage(chatId, `❌ Ваша запись на ${slotKey.replace(' ', ' в ')} отменена.`);
		bot.sendMessage(adminId, `🔕 Отмена:\n📅 ${slotKey}\n👤 ${user.first_name} (@${user.username})`);

		bot.answerCallbackQuery(query.id);
	}
});


// Команда /admin
bot.onText(/\/admin/, (msg) => {
	if (msg.from.id.toString() !== adminId) return;

	const bookings = loadBookings();
	let msgText = '📋 Записи:\n\n';
	for (const [date, users] of Object.entries(bookings)) {
		msgText += `📅 ${date}:\n`;
		users.forEach(u => {
			msgText += `— ${u.name} (@${u.username})\n`;
		});
		msgText += '\n';
	}

	bot.sendMessage(msg.chat.id, msgText || 'Пока никто не записался.');
});
