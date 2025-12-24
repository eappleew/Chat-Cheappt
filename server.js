const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();

/* =========================
   설정
========================= */

// 모델별 가격표
const PRICING = {
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'gpt-4-turbo': { input: 10.00, output: 30.00 },
    'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
    'o1-preview': { input: 15.00, output: 60.00 },
    'o1-mini': { input: 3.00, output: 12.00 },
    'dall-e-3': { per_image: 0.040 }
};

const EXCHANGE_RATE = 1400;

/* =========================
   미들웨어
========================= */

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, '.')));

/* =========================
   MySQL 연결 (Railway)
========================= */

const db = mysql.createConnection(process.env.DATABASE_URL);


db.connect(err => {
    if (err) {
        console.error('❌ MySQL 연결 실패:', err);
    } else {
        console.log('✅ MySQL 연결 성공');
    }
});

/* =========================
   API
========================= */

// 회원가입
app.post('/api/signup', async (req, res) => {
    const { name, email, password, apiKey } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = 'INSERT INTO users (name, email, password, api_key) VALUES (?, ?, ?, ?)';
        db.query(sql, [name, email, hashedPassword, apiKey], err => {
            if (err) return res.status(500).json({ message: '회원가입 실패' });
            res.status(201).json({ message: '가입 성공' });
        });
    } catch {
        res.status(500).json({ message: '서버 에러' });
    }
});

// 로그인
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.query('SELECT * FROM users WHERE email = ?', [email], (err, results) => {
        if (err || results.length === 0)
            return res.status(401).json({ message: '로그인 실패' });

        const user = results[0];
        bcrypt.compare(password, user.password, (_, isMatch) => {
            if (!isMatch) return res.status(401).json({ message: '비밀번호 불일치' });
            res.json({
                message: '성공',
                user: { id: user.id, name: user.name, profile_image: user.profile_image }
            });
        });
    });
});

// 대화 목록
app.get('/api/conversations/:userId', (req, res) => {
    db.query(
        'SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC',
        [req.params.userId],
        (err, results) => {
            if (err) return res.status(500).json({ error: 'DB 오류' });
            res.json(results);
        }
    );
});

// 메시지 목록
app.get('/api/conversations/:conversationId/messages', (req, res) => {
    db.query(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
        [req.params.conversationId],
        (err, results) => {
            if (err) return res.status(500).json({ error: 'DB 오류' });
            res.json(
                results.map(msg => ({
                    ...msg,
                    cost: msg.cost ? Math.round(msg.cost * EXCHANGE_RATE * 100) / 100 : 0
                }))
            );
        }
    );
});

// 이미지 목록
app.get('/api/images/:userId', (req, res) => {
    db.query(
        'SELECT * FROM generated_images WHERE user_id = ? ORDER BY created_at DESC',
        [req.params.userId],
        (err, results) => {
            if (err) return res.status(500).json({ error: 'DB 오류' });
            res.json(results);
        }
    );
});

// 채팅 API
app.post('/api/chat', async (req, res) => {
    try {
        const { userId, message, conversationId, model, image } = req.body;
        const selectedModel = model || 'gpt-4o';
        let currentConvId = conversationId;

        const [userRows] = await db.promise().query(
            'SELECT api_key FROM users WHERE id = ?',
            [userId]
        );
        if (!userRows.length) return res.status(400).json({ error: '유저 없음' });

        const openai = new OpenAI({ apiKey: userRows[0].api_key });

        if (!currentConvId) {
            const title = message?.substring(0, 20) || 'New Chat';
            const [r] = await db.promise().query(
                'INSERT INTO conversations (user_id, title) VALUES (?, ?)',
                [userId, title]
            );
            currentConvId = r.insertId;
        }

        await db.promise().query(
            'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
            [currentConvId, 'user', message]
        );

        const completion = await openai.chat.completions.create({
            model: selectedModel,
            messages: [{ role: 'user', content: message }]
        });

        const reply = completion.choices[0].message.content;
        const usage = completion.usage || { prompt_tokens: 0, completion_tokens: 0 };

        const price = PRICING[selectedModel] || PRICING['gpt-4o'];
        const cost =
            (usage.prompt_tokens * price.input +
                usage.completion_tokens * price.output) /
            1_000_000;

        await db.promise().query(
            'INSERT INTO messages (conversation_id, role, content, prompt_tokens, completion_tokens, cost, model) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [currentConvId, 'assistant', reply, usage.prompt_tokens, usage.completion_tokens, cost, selectedModel]
        );

        res.json({
            reply,
            conversationId: currentConvId,
            cost: Math.round(cost * EXCHANGE_RATE * 100) / 100
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

/* =========================
   서버 시작 (Railway 필수)
========================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 서버 실행 중: ${PORT}`);
});
