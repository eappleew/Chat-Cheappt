const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));
app.use(cors());

// DB 연결
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '1234', // 본인 비밀번호 확인!
    database: 'chatgpt_clone'
});

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
            if (isMatch) res.status(200).json({ message: '성공', user: { id: user.id, name: user.name } });
            else res.status(401).json({ message: '비밀번호 불일치' });
        });
    });
});

// 3. 대화 목록 가져오기
app.get('/api/conversations/:userId', (req, res) => {
    const sql = 'SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC';
    db.query(sql, [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: 'DB 오류' });
        res.json(results);
    });
});

// 4. 특정 대화의 메시지 내역 가져오기
app.get('/api/conversations/:conversationId/messages', (req, res) => {
    const sql = 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC';
    db.query(sql, [req.params.conversationId], (err, results) => {
        if (err) return res.status(500).json({ error: 'DB 오류' });
        res.json(results);
    });
});


// 5. [UPDATE] 채팅하기 (완벽 수정됨 🌟)
app.post('/api/chat', async (req, res) => {
    const { userId, message, conversationId, model } = req.body;
    const selectedModel = model || "gpt-4o";
    
    let currentConvId = conversationId;

    try {
        // 1. API Key 조회
        const [userRows] = await db.promise().query('SELECT api_key FROM users WHERE id = ?', [userId]);
        if (userRows.length === 0) return res.status(400).json({ error: '유저 정보 없음' });
        
        const apiKey = userRows[0].api_key;
        const openai = new OpenAI({ apiKey });

        // 2. 대화방 없으면 생성
        if (!currentConvId) {
            const title = message.substring(0, 20);
            const [convResult] = await db.promise().query('INSERT INTO conversations (user_id, title) VALUES (?, ?)', [userId, title]);
            currentConvId = convResult.insertId;
        }

        // 3. 유저 질문 저장
        await db.promise().query('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)', [currentConvId, 'user', message]);

        let reply = "";

        // ====================================================
        // 4. 모델에 따른 분기 처리 (이미지 vs 텍스트)
        // ====================================================
        if (selectedModel === 'dall-e-3') {
            // [A] 이미지 생성 모드
            try {
                const imageResponse = await openai.images.generate({
                    model: "dall-e-3",
                    prompt: message,
                    n: 1,
                    size: "1024x1024",
                });
                
                const imageUrl = imageResponse.data[0].url;
                
                // 프론트엔드에서 바로 보이게 HTML 태그로 저장
                reply = `<img src="${imageUrl}" alt="Generated Image" style="max-width: 100%; border-radius: 10px; margin-top: 10px;">`;
                
            } catch (imgError) {
                console.error("DALL-E Error:", imgError);
                reply = "이미지 생성 중 오류가 발생했습니다. (API 키 권한이나 크레딧을 확인하세요)";
            }

        } else {
            // [B] 일반 채팅 모드 (기존 로직)
            const systemMessage = {
                role: "system",
                content: `You are a helpful assistant. You are currently using the model: ${selectedModel}.`
            };

            // 이전 대화 기록 불러오기
            const [historyRows] = await db.promise().query(
                'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', 
                [currentConvId]
            );

            const messagesForAI = [
                systemMessage, 
                ...historyRows.map(row => ({ 
                    role: row.role,
                    content: row.content
                })),
                { role: "user", content: message } 
            ];

            const completion = await openai.chat.completions.create({
                model: selectedModel,
                messages: messagesForAI, 
            });

            reply = completion.choices[0].message.content;
        }

        // 5. AI 응답(또는 이미지 태그) DB 저장
        await db.promise().query('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)', [currentConvId, 'assistant', reply]);

        res.json({ reply, conversationId: currentConvId });

    } catch (error) {
        console.error('에러 발생:', error);
        res.status(500).json({ error: '서버 에러: ' + error.message });
    }
});

app.delete('/api/conversations/:id', (req, res) => {
    const conversationId = req.params.id;

    // 1. 메시지 먼저 삭제
    db.query('DELETE FROM messages WHERE conversation_id = ?', [conversationId], (err) => {
        if (err) return res.status(500).json({ error: '메시지 삭제 실패' });

        // 2. 대화방 삭제
        db.query('DELETE FROM conversations WHERE id = ?', [conversationId], (err) => {
            if (err) return res.status(500).json({ error: '대화방 삭제 실패' });
            res.json({ message: '삭제 성공' });
        });
    });
});

app.listen(3000, () => {
    console.log('🚀 서버 실행 중: http://localhost:3000');
});