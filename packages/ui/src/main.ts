import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import { useToast } from "./composables/useToast";
import { describeTechnical } from "./utils/error";
import { reportClientSystemError } from "./utils/api";
import "./styles.css";
import "./styles/record-dialog-content.css";
import "./components/DateTimePicker.css";

/* 滚动恢复由 AppShell 按页面路径手动管理，关闭浏览器默认恢复，避免前进/后退时双重跳动 */
if ("scrollRestoration" in window.history) {
  window.history.scrollRestoration = "manual";
}

const app = createApp(App);

/* 全局兜底：任何漏网的同步渲染错误或未捕获 rejection 都留痕并提示，杜绝“点了没反应” */
app.config.errorHandler = (error, instance, info) => {
  console.error("[health-records] 未处理的界面错误", { error, info, component: instance?.$?.type?.name });
  reportClientSystemError("vue", error);
};

window.addEventListener("unhandledrejection", (event) => {
  console.error("[health-records] 未处理的异步异常", event.reason);
  reportClientSystemError("promise", event.reason);
  useToast().show(`操作未生效，请重试（${describeTechnical(event.reason)}）`, 3600);
});

app.use(router).mount("#app");
