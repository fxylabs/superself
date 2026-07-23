import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Project = { id: string; name: string };
type LocalSession = { userId: string; spaceId: string; role: string };
type Work = {
  id: string;
  projectId: string;
  title: string;
  status: 'waiting' | 'in-progress' | 'done';
  revision: number;
};

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [work, setWork] = useState<Work[]>([]);
  const [session, setSession] = useState<LocalSession | null>(null);
  const [bootState, setBootState] = useState<'loading' | 'ready' | 'unpaired' | 'error'>('loading');
  const [bootError, setBootError] = useState('');
  const [name, setName] = useState('로컬 프로젝트');
  const [workTitle, setWorkTitle] = useState('첫 로컬 작업');

  async function reload(): Promise<boolean> {
    const [sessionResponse, projectsResponse, workResponse] = await Promise.all([
      fetch('/api/local/session'),
      fetch('/api/projects'),
      fetch('/api/work'),
    ]);
    if (sessionResponse.status === 401) return false;
    if (!sessionResponse.ok || !projectsResponse.ok || !workResponse.ok) {
      throw new Error('Local data could not be loaded');
    }
    setSession(await sessionResponse.json());
    setProjects(await projectsResponse.json());
    setWork(await workResponse.json());
    return true;
  }

  async function bootstrap() {
    try {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const pairingToken = fragment.get('pair');
      if (pairingToken) {
        const response = await fetch('/api/local/session/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: pairingToken }),
        });
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        if (!response.ok) {
          setBootState('unpaired');
          return;
        }
      }

      setBootState(await reload() ? 'ready' : 'unpaired');
    } catch (error) {
      setBootError(error instanceof Error ? error.message : String(error));
      setBootState('error');
    }
  }

  async function createProject() {
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await reload();
  }

  async function createWork() {
    const project = projects[0];
    if (!project) return;
    await fetch('/api/work', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, title: workTitle }),
    });
    await reload();
  }

  async function completeWork(item: Work) {
    await fetch(`/api/work/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: item.title, status: 'done' }),
    });
    await reload();
  }

  useEffect(() => { void bootstrap(); }, []);

  if (bootState === 'loading') {
    return <main><p>로컬 인스턴스에 연결하는 중…</p></main>;
  }

  if (bootState === 'unpaired') {
    return (
      <main>
        <p className="eyebrow">SUPERSELF LOCAL</p>
        <h1>이 브라우저는 아직 연결되지 않았습니다</h1>
        <p>터미널에서 Superself를 다시 열어 일회용 연결 링크를 사용하세요.</p>
      </main>
    );
  }

  if (bootState === 'error') {
    return <main><h1>로컬 인스턴스 연결 실패</h1><p>{bootError}</p></main>;
  }

  return (
    <main>
      <p className="eyebrow">SUPERSELF LOCAL</p>
      <h1>로그인 없이, 이 머신에 남는 작업 원장</h1>
      <p>Vite React UI와 Hono/SPFN API가 한 로컬 프로세스에서 동작합니다.</p>
      <p>{session ? `${session.userId} · ${session.spaceId} · ${session.role}` : 'local session 확인 중…'}</p>
      <section>
        <input
          aria-label="프로젝트 이름"
          name="projectName"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button onClick={() => void createProject()}>프로젝트 만들기</button>
      </section>
      <ul>{projects.map((project) => <li key={project.id}>{project.name}</li>)}</ul>
      <section>
        <input
          aria-label="작업 제목"
          name="workTitle"
          value={workTitle}
          onChange={(event) => setWorkTitle(event.target.value)}
        />
        <button disabled={projects.length === 0} onClick={() => void createWork()}>작업 만들기</button>
      </section>
      <ul>
        {work.map((item) => (
          <li key={item.id}>
            {item.title} · {item.status} · revision {item.revision}{' '}
            {item.status !== 'done' && <button onClick={() => void completeWork(item)}>완료</button>}
          </li>
        ))}
      </ul>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
