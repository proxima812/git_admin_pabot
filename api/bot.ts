require("dotenv").config()
import { Bot, webhookCallback } from "grammy"
import axios from "axios"
import dotenv from "dotenv"

// dotenv.config()

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

	// Обрабатываем каждую строку метаданных
	metadataLines.forEach(line => {
		const [key, value] = line.split(": ")
		if (value) {
			post[key.trim()] = value.replace(/["]/g, "")
		}
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

// Команда для начала создания нового поста
bot.command("new_post", async ctx => {
	userSessions[ctx.chat.id] = { post: {}, isNewPost: true, step: "title" }
	await ctx.reply("Введите заголовок для нового поста:")
})

// Обработчик ввода данных для нового поста
bot.on("message:text", async ctx => {
	const session = userSessions[ctx.chat.id]
	if (!session) return

	if (session.isNewPost) {
		switch (session.step) {
			case "title":
				session.post.title = ctx.message.text
				session.step = "description"
				await ctx.reply("Введите описание для нового поста:")
				break
			case "description":
				session.post.description = ctx.message.text
				session.step = "datePublished"
				await ctx.reply("Введите дату публикации (например, 'сегодня' или '31 октября'):")
				break
			case "datePublished":
				const inputDate = ctx.message.text.toLowerCase()
				if (inputDate === "сегодня") {
					const today = new Date().toISOString()
					session.post.datePublished = today
				} else {
					const formattedDate = new Date(inputDate).toISOString()
					session.post.datePublished = formattedDate
				}
				session.step = "content"
				await ctx.reply("Введите контент для нового поста в формате Markdown:")
				break
			case "content":
				session.post.content = ctx.message.text
				await ctx.reply(
					"Все данные собраны. Нажмите 'Добавить', чтобы создать пост, или 'Отмена' для выхода.",
					{
						reply_markup: new InlineKeyboard()
							.text("Добавить", "create_post")
							.row()
							.text("Отмена", "cancel"),
					},
				)
				break
		}
	} else {
		await ctx.reply(
			"Команда не распознана. Используйте /new_post для создания нового поста.",
		)
	}
})

// Обработчик создания нового поста
bot.callbackQuery("create_post", async ctx => {
	const session = userSessions[ctx.chat.id]
	if (!session || !session.isNewPost) return

	const post = session.post
	const fileName = `${post.title.replace(/ /g, "_").toLowerCase()}.md`

	const content = `---
title: "${post.title}"
description: "${post.description}"
datePublished: "${post.datePublished}"
---

${post.content}`

	try {
		await axios.put(
			`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/src/content/posts/${fileName}`,
			{
				message: `Добавлен новый пост: ${post.title}`,
				content: Buffer.from(content).toString("base64"),
				branch: process.env.GITHUB_BRANCH,
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
					Accept: "application/vnd.github.v3+json",
				},
			},
		)
		await ctx.reply("Новый пост успешно добавлен в репозиторий!")
		delete userSessions[ctx.chat.id]
	} catch (error) {
		console.error("Ошибка при добавлении нового поста:", error)
		await ctx.reply(
			"Произошла ошибка при добавлении поста. Пожалуйста, попробуйте еще раз.",
		)
	}
})

// Отмена добавления нового поста
bot.callbackQuery("cancel", ctx => {
	delete userSessions[ctx.chat.id]
	ctx.reply("Создание нового поста отменено.")
})

// Команда для отображения списка постов
bot.command("posts", async ctx => {
	const files = await getMarkdownFiles()
	const keyboard = new InlineKeyboard()

	files.forEach(file => keyboard.text(file.name, file.name).row())

	await ctx.reply("Посты сайта АП:", { reply_markup: keyboard })
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
	if (!session) return

	const post = session.post
	const fileName = session.fileName

	try {
		await saveMarkdownFile(fileName, post)
		await ctx.reply("Изменения успешно отправлены в репозиторий!")
		delete userSessions[ctx.chat.id]
	} catch (error) {
		console.error("Ошибка при отправке изменений:", error)
		await ctx.reply("Произошла ошибка при отправке изменений.")
	}
})

// Экспортируем вебхук для Vercel
export default webhookCallback(bot, "std/http")
