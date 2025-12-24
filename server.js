const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();

/* =========================
   설정 및 가격표
========================= */
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
   미들웨어 설정
========================= */
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, '.')));

// uploads 폴더가 없으면 자동 생성 (이미지 저장용)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

/* =========================
   MySQL 연결 (Railway 환경변수 적용)
========================= */
const db = mysql.createConnection({
    uri: process.env.DATABASE_URL
});

db.connect(err => {
    if (err) console.error('❌ MySQL 연결 실패:', err);
    else console.log('✅ MySQL 연결 성공');
});

/* =========================
   API 로직
========================= */

// 1. 회원가입
app.post('/api/signup', async (req, res) => {
    const { name, email, password, apiKey } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = 'INSERT INTO users (name, email, password, api_key) VALUES (?, ?, ?, ?)';
        db.query(sql, [name, email, hashedPassword, apiKey], (err) => {
            if (err) return res.status(500).json({ message: '회원가입 실패' });
            res.status(201).json({ message: '가입 성공' });
        });
    } catch (error) {
        res.status(500).json({ message: '서버 에러' });
    }
});

// 2. 로그인
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.query('SELECT * FROM users WHERE email = ?', [email], (err, results) => {
        if (err || results.length === 0) return res.status(401).json({ message: '로그인 실패' });
        const user = results[0];
        bcrypt.compare(password, user.password, (err, isMatch) => {
            if (isMatch) res.status(200).json({ 
                message: '성공', 
                user: { id: user.id, name: user.name, profile_image: user.profile_image, created_at: user.created_at } 
            });
            else res.status(401).json({ message: '비밀번호 불일치' });
        });
    });
});

// 3. 대화 목록/메시지 목록/이미지 목록
app.get('/api/conversations/:userId', (req, res) => {
    db.query('SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC', [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: 'DB 오류' });
        res.json(results);
    });
});

app.get('/api/conversations/:conversationId/messages', (req, res) => {
    db.query('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', [req.params.conversationId], (err, results) => {
        if (err) return res.status(500).json({ error: 'DB 오류' });
        res.json(results.map(msg => ({
            ...msg,
            cost: msg.cost ? Math.round(msg.cost * EXCHANGE_RATE * 100) / 100 : 0
        })));
    });
});

app.get('/api/images/:userId', (req, res) => {
    db.query('SELECT * FROM generated_images WHERE user_id = ? ORDER BY created_at DESC', [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: 'DB 오류' });
        res.json(results);
    });
});

// 4. 채팅 API (비용 계산 포함)
app.post('/api/chat', async (req, res) => {
    const { userId, message, conversationId, model, image } = req.body;
    const selectedModel = model || "gpt-4o";
    let currentConvId = conversationId;

    try {
        const [userRows] = await db.promise().query('SELECT api_key FROM users WHERE id = ?', [userId]);
        if (userRows.length === 0) return res.status(400).json({ error: '유저 정보 없음' });
        const openai = new OpenAI({ apiKey: userRows[0].api_key });

        if (!currentConvId) {
            const title = image ? "이미지 분석" : message.substring(0, 20);
            const [convResult] = await db.promise().query('INSERT INTO conversations (user_id, title) VALUES (?, ?)', [userId, title]);
            currentConvId = convResult.insertId;
        }

        const savedContent = image ? `[이미지 첨부됨] ${message}` : message;
        await db.promise().query('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)', [currentConvId, 'user', savedContent]);

        let reply = "";
        let usageData = { prompt_tokens: 0, completion_tokens: 0 };
        let totalCost = 0;

        if (selectedModel === 'dall-e-3') {
            const imageResponse = await openai.images.generate({
                model: "dall-e-3", prompt: message, n: 1, size: "1024x1024"
            });
            const originalUrl = imageResponse.data[0].url;
            const fileName = `img-${Date.now()}.png`;
            const localPath = path.join(uploadDir, fileName);
            const imgRes = await fetch(originalUrl);
            fs.writeFileSync(localPath, Buffer.from(await imgRes.arrayBuffer()));
            const webPath = `/uploads/${fileName}`;
            await db.promise().query('INSERT INTO generated_images (user_id, prompt, image_path) VALUES (?, ?, ?)', [userId, message, webPath]);
            reply = `<img src="${webPath}" alt="${message}" style="max-width: 100%; border-radius: 10px; margin-top: 10px;">`;
            totalCost = PRICING['dall-e-3'].per_image;
        } else {
            const [historyRows] = await db.promise().query('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', [currentConvId]);
            const messagesForAI = [
                { role: "system", content: req.body.systemInstruction || `You are a helpful assistant. Model: ${selectedModel}.` },
                ...historyRows.map(row => ({ role: row.role, content: row.content }))
            ];
            
            if (image) messagesForAI.push({ role: "user", content: [{ type: "text", text: message || "설명해줘" }, { type: "image_url", image_url: { url: image } }] });
            else messagesForAI.push({ role: "user", content: message });

            const completion = await openai.chat.completions.create({ model: selectedModel, messages: messagesForAI });
            reply = completion.choices[0].message.content;
            if (completion.usage) {
                usageData = completion.usage;
                const priceInfo = PRICING[selectedModel] || PRICING['gpt-4o'];
                totalCost = (usageData.prompt_tokens * priceInfo.input + usageData.completion_tokens * priceInfo.output) / 1000000;
            }
        }

        await db.promise().query(
            'INSERT INTO messages (conversation_id, role, content, prompt_tokens, completion_tokens, cost, model) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [currentConvId, 'assistant', reply, usageData.prompt_tokens, usageData.completion_tokens, totalCost, selectedModel]
        );

        res.json({ reply, conversationId: currentConvId, cost: Math.round(totalCost * EXCHANGE_RATE * 100) / 100, tokens: usageData.total_tokens });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. 사용량 대시보드 (가입일, 누적 금액)
app.get('/api/user/:id/usage', async (req, res) => {
    try {
        const userId = req.params.id;
        const [chatRows] = await db.promise().query('SELECT SUM(cost) as total_cost, COUNT(*) as total_count FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)', [userId]);
        const [imgRows] = await db.promise().query('SELECT COUNT(*) as total_count FROM generated_images WHERE user_id = ?', [userId]);
        const [userRows] = await db.promise().query('SELECT created_at FROM users WHERE id = ?', [userId]);

        const imageCostDollar = imgRows[0].total_count * 0.04;
        const chatCostDollar = chatRows[0].total_cost || 0;
        const totalCostDollar = chatCostDollar + imageCostDollar;

        res.json({
            cost: Math.round(totalCostDollar * EXCHANGE_RATE),
            messageCount: chatRows[0].total_count,
            imageCount: imgRows[0].total_count,
            apiCostDollar: totalCostDollar.toFixed(4),
            joinDate: userRows[0] ? userRows[0].created_at : null
        });
    } catch (err) {
        res.status(500).json({ error: 'DB Error' });
    }
});

/* 나머지 삭제/수정 API 생략 (기존과 동일) */
app.delete('/api/conversations/:id', (req, res) => {
    db.query('DELETE FROM messages WHERE conversation_id = ?', [req.params.id], () => {
        db.query('DELETE FROM conversations WHERE id = ?', [req.params.id], () => res.json({ message: '삭제 성공' }));
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 서버 실행 중: ${PORT}`));
