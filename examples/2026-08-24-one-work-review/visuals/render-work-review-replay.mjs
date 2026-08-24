import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const outDir = resolve(process.argv[2] ?? '/tmp/work-review-replay-output');
mkdirSync(outDir, { recursive: true });

const XML = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const locales = {
    ko: {
        file: 'work-review-replay.ko',
        eyebrow: 'SUPERSELF · ONE WORK',
        introTitle: ['한 작업을 맡기고,', '계획부터 결과까지 검토합니다'],
        introBody: ['실제 작업 w-cs7dj', '계획 v1 → 리뷰 → 계획 v2 → 실행 → 보고'],
        stages: ['계획 등록', '계획 리뷰', 'v2 수정', '승인·실행', '보고·완료'],
        scenes: [
            {
                role: '사용자 → 에이전트', title: '파일을 고치기 전에 계획부터',
                lines: ['로컬 Markdown 링크 검사기를 추가하세요.', '구현 전에 전체 계획을 work에 올리세요.'],
                code: ['self work propose "Add a local Markdown link checker…"'],
                state: 'REVIEW', version: '계획 v1', detail: ['w-cs7dj', '아직 승인되지 않음'],
                result: '승인 전 start는 차단됩니다.',
            },
            {
                role: '리뷰 에이전트', title: 'v1에서 결함 두 개 발견',
                lines: ['01  docs/*.md와 재귀 탐색 범위가 맞지 않음', '02  다른 파일의 #fragment 처리 규칙이 없음'],
                code: ['사용자: 두 지적을 반영하고 다시 리뷰하세요.'],
                state: 'REVIEW', version: '계획 v1', detail: ['시작 보류', '수정이 필요함'],
                result: '계획도 틀릴 수 있으므로 실행 전에 읽습니다.',
            },
            {
                role: '에이전트 → 리뷰 에이전트', title: '같은 work ID에서 v2로 수정',
                lines: ['01  docs/**/*.md로 범위를 명확히 함', '02  #fragment를 뺀 뒤 파일 존재 여부 확인', '두 번째 리뷰: 차단할 결함 없음'],
                code: ['self work revise w-cs7dj "…" --why "…"'],
                state: 'REVIEW', version: '계획 v2', detail: ['같은 ID · w-cs7dj', '두 번째 리뷰 통과'],
                result: '수정 전·후 계획이 한 work의 이력에 남습니다.',
            },
            {
                role: '사용자 → 에이전트', title: '검토가 끝난 v2만 승인하고 실행',
                lines: ['사용자가 v2를 승인합니다.', '에이전트가 구현하고 계획에 적힌 검증을 실행합니다.'],
                code: ['self work accept w-cs7dj', 'self work start w-cs7dj', 'npm test  →  4/4 pass', 'check:links  →  3 files'],
                state: 'ACTIVE', version: '승인된 v2', detail: ['구현 커밋 fea913a', '검증 2개 통과'],
                result: 'accept는 사람이, start와 구현은 에이전트가 맡습니다.',
            },
            {
                role: '에이전트 → 사용자', title: '보고와 증거를 읽고 완료 판단',
                lines: ['보고의 커밋과 테스트 결과가 v2와 맞는지 확인합니다.', '맞으면 사용자가 work를 완료로 바꿉니다.'],
                code: ['self report w-cs7dj "… fea913a … 4/4 …"', 'self work done w-cs7dj'],
                state: 'DONE', version: 'w-cs7dj', detail: ['Evidence · fea913a · settled', 'Report · attached'],
                result: 'done에는 승인된 계획, 보고, 검증 증거가 함께 남습니다.',
            },
        ],
        footer: '실제 기록 · 2026-08-24 · 재생 시간 39초',
    },
    en: {
        file: 'work-review-replay',
        eyebrow: 'SUPERSELF · ONE WORK',
        introTitle: ['Hand off one task,', 'inspect the plan, then judge the result'],
        introBody: ['Recorded work w-cs7dj', 'plan v1 → review → plan v2 → execution → report'],
        stages: ['Propose', 'Review', 'Revise v2', 'Accept · run', 'Report · done'],
        scenes: [
            {
                role: 'OPERATOR → AGENT', title: 'Start with a plan, not a file change',
                lines: ['Add a local Markdown link checker.', 'Put the full plan in work before implementation.'],
                code: ['self work propose "Add a local Markdown link checker…"'],
                state: 'REVIEW', version: 'PLAN v1', detail: ['w-cs7dj', 'not accepted'],
                result: 'The start gate blocks an unaccepted plan.',
            },
            {
                role: 'REVIEW AGENT', title: 'The first review finds two defects',
                lines: ['01  docs/*.md conflicts with recursive discovery', '02  cross-file #fragment handling is undefined'],
                code: ['Operator: apply both findings, then run review again.'],
                state: 'REVIEW', version: 'PLAN v1', detail: ['start held', 'revision required'],
                result: 'The operator reads the plan before any implementation starts.',
            },
            {
                role: 'AGENT → REVIEW AGENT', title: 'Record v2 under the same work ID',
                lines: ['01  use docs/**/*.md as the supported scope', '02  strip #fragment before checking the file', 'Second review: no blocking defect'],
                code: ['self work revise w-cs7dj "…" --why "…"'],
                state: 'REVIEW', version: 'PLAN v2', detail: ['same ID · w-cs7dj', 'second review passed'],
                result: 'Both revisions remain in one work history.',
            },
            {
                role: 'OPERATOR → AGENT', title: 'Accept reviewed v2, then start',
                lines: ['The operator accepts v2.', 'The agent implements it and runs the checks named in the plan.'],
                code: ['self work accept w-cs7dj', 'self work start w-cs7dj', 'npm test  →  4/4 pass', 'check:links  →  3 files'],
                state: 'ACTIVE', version: 'ACCEPTED v2', detail: ['commit fea913a', 'two checks passed'],
                result: 'A person accepts. The agent starts, implements, and tests.',
            },
            {
                role: 'AGENT → OPERATOR', title: 'Read the report before marking done',
                lines: ['Check the report against v2, the commit, and both test results.', 'Mark the work done only when they match.'],
                code: ['self report w-cs7dj "… fea913a … 4/4 …"', 'self work done w-cs7dj'],
                state: 'DONE', version: 'w-cs7dj', detail: ['Evidence · fea913a · settled', 'Report · attached'],
                result: 'The finished work keeps the accepted plan, report, and evidence.',
            },
        ],
        footer: 'Recorded run · 2026-08-24 · 39 seconds',
    },
};

function textLines(lines, x, y, { size = 26, color = '#ffffff', weight = 500, gap = 38, family = 'Inter, SUIT, Arial, sans-serif' } = {}) {
    return `<text x="${x}" y="${y}" fill="${color}" font-family="${family}" font-size="${size}" font-weight="${weight}">${lines.map((line, i) => `<tspan x="${x}" dy="${i ? gap : 0}">${XML(line)}</tspan>`).join('')}</text>`;
}

function progress(data, active) {
    const width = 1040 / data.stages.length;
    return data.stages.map((label, i) => {
        const x = 80 + i * width;
        const on = i === active;
        const done = i < active;
        const color = on ? '#51a2ff' : done ? '#ffffff' : '#5f5f5f';
        const line = i < data.stages.length - 1 ? `<line x1="${x + 32}" y1="129" x2="${x + width - 12}" y2="129" stroke="${done ? '#51a2ff' : '#303030'}" stroke-width="2"/>` : '';
        return `${line}<circle cx="${x + 14}" cy="129" r="14" fill="${on ? '#51a2ff' : done ? '#ffffff' : '#1e1e1e'}" stroke="${on ? '#51a2ff' : '#3a3a3a'}"/><text x="${x + 14}" y="135" text-anchor="middle" fill="${on ? '#0f0f0f' : done ? '#0f0f0f' : '#8a8a8a'}" font-family="JetBrains Mono, monospace" font-size="15" font-weight="700">${i + 1}</text><text x="${x + 40}" y="135" fill="${color}" font-family="Inter, SUIT, Arial, sans-serif" font-size="17" font-weight="600">${XML(label)}</text>`;
    }).join('');
}

function background(data, counter) {
    const faded = ['work.proposed   w-cs7dj', 'plan.revised    v2', 'entity.confirmed', 'entity.started', 'report.added     fea913a', 'work.done        settled'];
    return `<rect width="1200" height="675" fill="#0f0f0f"/><g fill="#ffffff" opacity="0.035" font-family="JetBrains Mono, monospace" font-size="14">${faded.map((line, i) => `<text x="${i % 2 ? 845 : 36}" y="${52 + i * 104}">${line}</text>`).join('')}</g><text x="48" y="58" fill="#51a2ff" font-family="JetBrains Mono, monospace" font-size="15" font-weight="700" letter-spacing="1.2">${data.eyebrow}</text><text x="1152" y="58" text-anchor="end" fill="#777777" font-family="JetBrains Mono, monospace" font-size="15">${counter}</text>`;
}

function wrap(svgBody, data, counter) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" role="img"><rect width="1200" height="675" fill="#0f0f0f"/>${background(data, counter)}${svgBody}<text x="48" y="645" fill="#777777" font-family="JetBrains Mono, SUIT, monospace" font-size="14">${XML(data.footer)}</text><text x="1152" y="645" text-anchor="end" fill="#777777" font-family="JetBrains Mono, monospace" font-size="14">superselfs.com</text></svg>`;
}

function intro(data) {
    const pills = data.stages.map((label, i) => `<g transform="translate(${48 + i * 220} 455)"><rect width="196" height="62" fill="${i === 0 ? '#51a2ff' : '#1e1e1e'}" stroke="${i === 0 ? '#51a2ff' : '#333333'}"/><text x="18" y="26" fill="${i === 0 ? '#0f0f0f' : '#8d8d8d'}" font-family="JetBrains Mono, monospace" font-size="14">0${i + 1}</text><text x="18" y="49" fill="${i === 0 ? '#0f0f0f' : '#ffffff'}" font-family="Inter, SUIT, Arial, sans-serif" font-size="18" font-weight="650">${XML(label)}</text></g>`).join('');
    return wrap(`${textLines(data.introTitle, 48, 165, { size: 48, gap: 58, weight: 600 })}${textLines(data.introBody, 52, 318, { size: 23, gap: 36, color: '#a0a0a0', weight: 450 })}<line x1="48" y1="400" x2="1152" y2="400" stroke="#2c2c2c"/>${pills}`, data, '00 / 05');
}

function scene(data, scene, index) {
    const codeHeight = scene.code.length * 34 + 26;
    const body = `${progress(data, index)}
        <rect x="48" y="171" width="732" height="388" fill="#151515" stroke="#2c2c2c"/>
        <text x="78" y="210" fill="#51a2ff" font-family="JetBrains Mono, SUIT, monospace" font-size="15" font-weight="700" letter-spacing="1">${XML(scene.role)}</text>
        <text x="78" y="258" fill="#ffffff" font-family="Inter, SUIT, Arial, sans-serif" font-size="32" font-weight="650">${XML(scene.title)}</text>
        ${textLines(scene.lines, 78, 305, { size: 23, gap: 38, color: '#c8c8c8', weight: 450 })}
        <rect x="78" y="${522 - codeHeight}" width="672" height="${codeHeight}" fill="#0b0b0b" stroke="#333333"/>
        ${scene.code.map((line, i) => `<text x="100" y="${522 - codeHeight + 35 + i * 34}" fill="${i === 0 ? '#ffffff' : '#b8b8b8'}" font-family="JetBrains Mono, SUIT, monospace" font-size="18"><tspan fill="#51a2ff">${i === 0 ? '$ ' : '  '}</tspan>${XML(line)}</text>`).join('')}
        <rect x="804" y="171" width="348" height="388" fill="#ffffff" stroke="#ffffff"/>
        <rect x="834" y="201" width="${scene.state.length > 7 ? 118 : 96}" height="34" fill="${scene.state === 'DONE' ? '#dff8e8' : scene.state === 'ACTIVE' ? '#dcecff' : '#e9f3ff'}"/>
        <text x="850" y="224" fill="${scene.state === 'DONE' ? '#14532d' : '#174b82'}" font-family="JetBrains Mono, monospace" font-size="15" font-weight="700">${XML(scene.state)}</text>
        <text x="834" y="292" fill="#0f0f0f" font-family="Inter, SUIT, Arial, sans-serif" font-size="31" font-weight="700">${XML(scene.version)}</text>
        ${textLines(scene.detail, 834, 346, { size: 21, gap: 38, color: '#545454', weight: 500 })}
        <line x1="834" y1="448" x2="1122" y2="448" stroke="#dedede"/>
        <text x="834" y="484" fill="#767676" font-family="JetBrains Mono, SUIT, monospace" font-size="15">WORK STATE</text>
        <circle cx="1098" cy="478" r="7" fill="${scene.state === 'DONE' ? '#35c46b' : '#51a2ff'}"/>
        <rect x="48" y="581" width="1104" height="42" fill="#51a2ff"/>
        <text x="600" y="608" text-anchor="middle" fill="#07101a" font-family="Inter, SUIT, Arial, sans-serif" font-size="19" font-weight="700">${XML(scene.result)}</text>`;
    return wrap(body, data, `0${index + 1} / 05`);
}

function run(command, args) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

const durations = [4.5, 6.5, 7, 7, 7, 7];
for (const data of Object.values(locales)) {
    const scratch = mkdtempSync(join(tmpdir(), `${data.file}-`));
    try {
        const family = data.file.endsWith('.ko') ? 'Apple SD Gothic Neo' : 'Arial';
        const mono = data.file.endsWith('.ko') ? 'Apple SD Gothic Neo' : 'Menlo-Regular';
        const svgs = [intro(data), ...data.scenes.map((item, i) => scene(data, item, i))].map((svg) => svg
            .replaceAll('Inter, SUIT, Arial, sans-serif', family)
            .replaceAll('JetBrains Mono, SUIT, monospace', mono)
            .replaceAll('JetBrains Mono, monospace', mono));
        const pngs = [];
        svgs.forEach((svg, i) => {
            const svgPath = join(scratch, `scene-${i}.svg`);
            const pngPath = join(scratch, `scene-${i}.png`);
            writeFileSync(svgPath, svg);
            run('magick', ['-background', '#0f0f0f', svgPath, pngPath]);
            pngs.push(pngPath);
        });
        writeFileSync(join(outDir, `${data.file}.svg`), svgs[0]);
        const list = pngs.map((file, i) => `file '${file}'\nduration ${durations[i]}`).join('\n') + `\nfile '${pngs.at(-1)}'\n`;
        const concatPath = join(scratch, 'concat.txt');
        writeFileSync(concatPath, list);
        run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-t', String(durations.reduce((sum, seconds) => sum + seconds, 0)), '-vf', 'fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', join(outDir, `${data.file}.mp4`)]);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

console.log(`Rendered replay assets in ${outDir}`);
