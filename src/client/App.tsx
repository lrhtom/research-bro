import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { apiGetSettings, apiSetSetting } from './lib/api';

import HomePage from './pages/HomePage';
import ThreeLineTablePage from './pages/ThreeLineTablePage';
import VisualizationsPage from './pages/VisualizationsPage';
import CoursesPage from './pages/CoursesPage';
import ConvertersPage from './pages/ConvertersPage';
import ContestsPage from './pages/ContestsPage';
import AssetsPage from './pages/AssetsPage';
import AiNewsPage from './pages/AiNewsPage';
import PaperCheckPage from './pages/PaperCheckPage';
import NotesPage from './pages/NotesPage';
import OjProblemsPage from './pages/OjProblemsPage';
import OjProblemPage from './pages/OjProblemPage';
import OjGeneratePage from './pages/OjGeneratePage';
import OjSubmissionsPage from './pages/OjSubmissionsPage';
import OjSettingsPage from './pages/OjSettingsPage';
import PlansPage from './pages/PlansPage';
import PlanDetailPage from './pages/PlanDetailPage';
import StudyPage from './pages/StudyPage';
import ResultPage from './pages/ResultPage';
import SpeakingSetupPage from './pages/SpeakingSetupPage';
import SpeakingRoomPage from './pages/SpeakingRoomPage';
import SpeakingReportPage from './pages/SpeakingReportPage';
import SpeakingHistoryPage from './pages/SpeakingHistoryPage';
import ProfilePage from './pages/ProfilePage';
import AssistantBall from './components/AssistantBall';

/**
 * 「今天」按用户时区的日历日切，而这件事发生在服务端 ——
 * 服务端猜不到浏览器在哪个时区，所以首次加载时把它报上去存进 settings。
 * 只在没存过、或者跟当前浏览器不一致时才写，不会每次刷新都打一次接口。
 */
function useReportTimeZone(): void {
    useEffect(() => {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (!tz) return;
        void apiGetSettings()
            .then((s) => { if (s.timezone !== tz) return apiSetSetting('timezone', tz); })
            .catch(() => { /* 报不上去就用服务端的默认时区，不影响使用 */ });
    }, []);
}

export default function App() {
    useReportTimeZone();

    return (
        <BrowserRouter>
            <Routes>
                <Route path="/" element={<HomePage />} />
                {/* 个人中心不在 /tools 底下：它不是工具，是「你」 */}
                <Route path="/me" element={<ProfilePage />} />
                <Route path="/tools/three-line-table" element={<ThreeLineTablePage />} />
                <Route path="/tools/visualizations" element={<VisualizationsPage />} />
                <Route path="/tools/courses" element={<CoursesPage />} />
                <Route path="/tools/contests" element={<ContestsPage />} />
                <Route path="/tools/ai-news" element={<AiNewsPage />} />
                <Route path="/tools/assets" element={<AssetsPage />} />
                <Route path="/tools/converters" element={<ConvertersPage />} />
                <Route path="/tools/paper-check" element={<PaperCheckPage />} />
                <Route path="/tools/notes" element={<NotesPage />} />

                {/* 算法题库。固定段全部写在 :problemId 之前，
                    否则 generate / submissions / settings 会被当成题目 id */}
                <Route path="/tools/oj" element={<OjProblemsPage />} />
                <Route path="/tools/oj/generate" element={<OjGeneratePage />} />
                <Route path="/tools/oj/submissions" element={<OjSubmissionsPage />} />
                <Route path="/tools/oj/settings" element={<OjSettingsPage />} />
                <Route path="/tools/oj/:problemId" element={<OjProblemPage />} />

                <Route path="/tools/flashcards" element={<PlansPage />} />
                {/* 学习统计整块搬进了个人中心。旧路由留着重定向 ——
                    书签、站内搜索索引、以及 AI 助手的站内地图都还指着它，
                    直接删掉会变成一个 404，而这条路由曾经是真实存在的。
                    固定段仍要写在 :planId 之前，否则 stats 会被当成计划 id */}
                <Route path="/tools/flashcards/stats" element={<Navigate to="/me" replace />} />
                <Route path="/tools/flashcards/:planId" element={<PlanDetailPage />} />
                <Route path="/tools/flashcards/:planId/study" element={<StudyPage />} />
                <Route path="/tools/flashcards/:planId/result" element={<ResultPage />} />

                {/* 固定段写在 :sessionId 之前，理由同 flashcards/stats */}
                <Route path="/tools/speaking" element={<SpeakingSetupPage />} />
                <Route path="/tools/speaking/history" element={<SpeakingHistoryPage />} />
                <Route path="/tools/speaking/:sessionId" element={<SpeakingRoomPage />} />
                <Route path="/tools/speaking/:sessionId/report" element={<SpeakingReportPage />} />

                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>

            {/* 悬浮球在 Routes 外面、BrowserRouter 里面：它要跟着页面切换活着
                （不能被路由卸载，否则每跳一次页对话就没了），但自己要能
                useNavigate / useLocation */}
            <AssistantBall />
        </BrowserRouter>
    );
}
