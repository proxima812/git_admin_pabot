const { Bot, InlineKeyboard } = require("grammy")
const axios = require("axios")
require("dotenv").config()

const bot = new Bot(process.env.BOT_TOKEN)

// Для хранения данных о постах во время редактирования
let userSessions = {}

// Функция для получения списка файлов из папки `posts` через GitHub API
async function getMarkdownFiles() {
	const response = await axios.get(
		`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/src/content/posts`,
		{
			headers: {
				Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
				Accept: "application/vnd.github.v3+json",
			},
		},
	)
	return response.data.filter(file => file.name.endsWith(".md"))
}

// Функция для чтения и парсинга содержимого .md файла через GitHub API
async function fetchMarkdownFileContent(fileName) {
	const response = await axios.get(
		`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/src/content/posts/${fileName}`,
		{
			headers: {
				Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
				Accept: "application/vnd.github.v3+json",
			},
		},
	)

	const contentBuffer = Buffer.from(response.data.content, "base64").toString("utf8")
	const [metadata, postContent] = contentBuffer.split("---\n\n").map(part => part.trim())
	const metadataLines = metadata.split("\n")
	const post = { content: postContent }

	metadataLines.forEach(line => {
		const [key, value] = line.split(": ")
		post[key.trim()] = value.replace(/["]/g, "")
	})

	post.sha = response.data.sha // Сохраняем SHA для обновления файла
	return post
}

// Функция для сохранения обновленного поста на GitHub
async function saveMarkdownFile(fileName, post) {
	const metadata = `---
title: "${post.title}"
description: "${post.description}"
datePublished: "${post.datePublished}"
---
`

	const content = `${metadata}\n${post.content}`
	await axios.put(
		`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/src/content/posts/${fileName}`,
		{
			message: `Updated post: ${post.title}`,
			content: Buffer.from(content).toString("base64"),
			branch: process.env.GITHUB_BRANCH,
			sha: post.sha,
		},
		{
			headers: {
				Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
				Accept: "application/vnd.github.v3+json",
			},
		},
	)
}

// Команда для отображения списка постов
bot.command("posts", async ctx => {
	const files = await getMarkdownFiles()
	const keyboard = new InlineKeyboard()

	files.forEach(file => keyboard.text(file.name).row())

	ctx.reply("Посты сайта АП:", { reply_markup: keyboard })
})

// Обработчик нажатий на кнопки выбора файла
bot.on("callback_query:data", async ctx => {
	const fileName = ctx.callbackQuery.data
	const post = await fetchMarkdownFileContent(fileName)

	userSessions[ctx.chat.id] = { fileName, post }
	const keyboard = new InlineKeyboard()
		.text("Изменить title", "edit_title")
		.row()
		.text("Изменить description", "edit_description")
		.row()
		.text("Изменить datePublished", "edit_datePublished")
		.row()
		.text("Изменить контент", "edit_content")
		.row()
		.text("Добавить", "add")
		.text("Отправить изменения", "commit")

	await ctx.reply(
		`Пост ${fileName}:\n\n` +
			`*title*: ${post.title}\n` +
			`*description*: ${post.description}\n` +
			`*datePublished*: ${post.datePublished}\n\n` +
			`${post.content}`,
		{ parse_mode: "Markdown", reply_markup: keyboard },
	)
})

// Функция для обновления атрибутов
async function updateAttribute(ctx, attribute) {
	const session = userSessions[ctx.chat.id]
	if (!session) return ctx.reply("Сначала выберите пост с помощью команды /posts.")

	session.editingAttribute = attribute
	await ctx.reply(`Введите новое значение для ${attribute}:`)
}

// Обработчики для кнопок изменения
bot.callbackQuery("edit_title", ctx => updateAttribute(ctx, "title"))
bot.callbackQuery("edit_description", ctx => updateAttribute(ctx, "description"))
bot.callbackQuery("edit_datePublished", ctx => updateAttribute(ctx, "datePublished"))
bot.callbackQuery("edit_content", ctx => updateAttribute(ctx, "content"))

// Сохранение изменений пользователя
bot.on("message:text", async ctx => {
	const session = userSessions[ctx.chat.id]
	if (!session || !session.editingAttribute) return

	session.post[session.editingAttribute] = ctx.message.text
	await ctx.reply("Изменение сохранено. Что-то еще?", {
		reply_markup: new InlineKeyboard()
			.text("Изменить title", "edit_title")
			.row()
			.text("Изменить description", "edit_description")
			.row()
			.text("Изменить datePublished", "edit_datePublished")
			.row()
			.text("Изменить контент", "edit_content")
			.row()
			.text("Добавить", "add")
			.text("Отправить изменения", "commit"),
	})

	session.editingAttribute = null
})

// Команда для отправки изменений в GitHub
bot.callbackQuery("commit", async ctx => {
	const session = userSessions[ctx.chat.id]
	if (!session) return ctx.reply("Сначала выберите пост с помощью команды /posts.")

	const { fileName, post } = session

	try {
		await saveMarkdownFile(fileName, post)
		delete userSessions[ctx.chat.id]
		await ctx.reply("Изменения успешно отправлены в GitHub!")
	} catch (error) {
		console.error(error)
		ctx.reply("Произошла ошибка при отправке изменений в GitHub.")
	}
})

// Запуск бота
bot.start({
	onWebhook: {
		domain: `https://${process.env.VERCEL_URL}`,
		secretToken: process.env.WEBHOOK_SECRET,
	},
})
