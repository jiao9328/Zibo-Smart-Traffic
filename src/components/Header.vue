
<template>
  <header class="header">
    <!-- 左：时钟 -->
    <div class="header-left">
      <div class="timer">
        <p class="time-date">{{ time1 }}</p>
        <p class="time-clock">{{ time2 }}</p>
      </div>
    </div>

    <!-- 中：标题 -->
    <div class="header-center">
      <div class="logo">
        <!-- 红绿灯图标：原为 🚦 emoji（彩色位图字体，无法随主题着色，也不受字重影响） -->
        <span class="logo-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <rect x="6" y="2.5" width="12" height="19" rx="3.4" />
            <circle class="lamp-red" cx="12" cy="7.2" r="1.9" />
            <circle class="lamp-yellow" cx="12" cy="12" r="1.9" />
            <circle class="lamp-green" cx="12" cy="16.8" r="1.9" />
          </svg>
        </span>
        <h1 class="header-title">淄博市智慧交通管理系统</h1>
      </div>
      <p class="header-sub">ZIBO SMART TRANSPORTATION MANAGEMENT SYSTEM</p>
    </div>

    <!-- 右：当前用户 + 退出登录（标题由 .header-center absolute 居中，不受两侧内容影响） -->
    <div class="header-right">
      <div class="user-box">
        <span class="user-name">
          <svg class="user-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="8" r="3.7" />
            <path d="M4.6 20.2a7.4 7.4 0 0 1 14.8 0z" />
          </svg>
          {{ store.user?.display_name || store.user?.username || '未登录' }}
        </span>
        <button class="logout-btn" @click="onLogout">退出登录</button>
      </div>
    </div>
  </header>
</template>

<script setup>
import { computed, ref, onMounted, inject } from "vue";
import { useRouter } from 'vue-router'
import { clearAuthUser } from '../store'

const { store } = inject('$store')
const router = useRouter()

// 退出登录：清登录态 + 关闭可能残留的全局面板（数据管理/控制中心），回登录页
const onLogout = () => {
  clearAuthUser()
  store.chartsOpen = false
  store.dataPanelOpen = false
  router.push('/login')
}

const year = ref(0);
const month = ref(0);
const day = ref(0);
const hour = ref(0);
const minute = ref(0);
const second = ref(0);

const updateTime = () => {
  const date = new Date();
  year.value = date.getFullYear();
  month.value = ('0' + (date.getMonth() + 1)).slice(-2);
  day.value = ('0' + date.getDate()).slice(-2);
  hour.value = ('0' + date.getHours()).slice(-2);
  minute.value = ('0'+date.getMinutes()).slice(-2);
  second.value = ('0'+date.getSeconds()).slice(-2);
};

onMounted(() => {
  // 初始调用一次
  updateTime();
  // 设置每秒钟更新一次
  setInterval(updateTime, 1000);
});

const time1 = computed(() => {
  return `${year.value}-${month.value}-${day.value}`;
});

const time2 = computed(() => {
  return `${hour.value}:${minute.value}:${second.value}`;
});
</script>

<style scoped>
/* ===== 顶部栏：白底卡片条 + 左时钟 + 居中标题 + 右用户 =====
 * 原为藏青玻璃渐变 + 蓝光边框，和白色卡片面板是两套语言，统一到 --bg-panel。 */
.header {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: var(--header-h);
  box-sizing: border-box;
  z-index: var(--z-header);
  display: flex;
  align-items: center;
  padding: 0 20px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  box-shadow: var(--shadow);
}

/* 左右伸缩区（左时钟/右留空） */
.header-left,
.header-right {
  flex: 1;
  display: flex;
  align-items: center;
  min-width: 0;
}

.header-right {
  justify-content: flex-end;
}

/* 中间标题块：绝对居中，不受两侧内容宽度影响 */
.header-center {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  line-height: 1;
}

/* 红绿灯图标：灯身用主色，三个灯位保留语义色（这是全站唯一该有红黄绿的地方） */
.logo-icon svg {
  display: block;
  width: 22px;
  height: 22px;
  fill: var(--primary);
}
.logo-icon .lamp-red {
  fill: var(--danger);
}
.logo-icon .lamp-yellow {
  fill: var(--warn);
}
.logo-icon .lamp-green {
  fill: var(--ok);
}

.header-title {
  margin: 0;
  font-size: 21px;
  color: var(--text);
  letter-spacing: 3px;
  font-weight: 700;
  white-space: nowrap;
}

.header-sub {
  margin: 3px 0 0;
  font-size: 10px;
  color: var(--text-mute);
  letter-spacing: 2px;
  white-space: nowrap;
}

.timer {
  text-align: left;
  line-height: 1.2;
}

.time-date {
  margin: 0;
  font-size: 12px;
  color: var(--text-sub);
}

.time-clock {
  margin: 0;
  font-size: 20px;
  font-variant-numeric: tabular-nums; /* 秒跳动时不抖宽度 */
  font-family: Consolas, "DIN Alternate", monospace;
  letter-spacing: 1px;
  color: var(--primary);
}

/* 右：用户胶囊 + 退出按钮 */
.user-box {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 5px 4px 12px;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: var(--bg-sub);
  transition: border-color 0.2s;
}
.user-box:hover {
  border-color: var(--border-strong);
}
.user-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-sub);
  white-space: nowrap;
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.user-icon {
  flex: none;
  width: 14px;
  height: 14px;
  fill: var(--text-mute);
}
.logout-btn {
  padding: 4px 12px;
  font-size: 12px;
  color: var(--primary);
  background: var(--primary-soft);
  border: none;
  border-radius: 14px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.logout-btn:hover {
  background: var(--primary);
  color: #fff;
}
</style>
