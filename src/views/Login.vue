<template>
  <!-- 全屏不透明覆盖层（z-index 9999 盖过地图/Header/所有浮层）：
       登录前地图仍在后台就绪，登录成功后进入即用，无二次加载 -->
  <div class="login-overlay">
    <div class="login-decor"></div>
    <div class="login-card">
      <div class="login-brand">
        <!-- 与 Header 同款红绿灯 SVG（原为 🚦 emoji，在浅色卡片上显得脏且不可着色） -->
        <span class="brand-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <rect x="6" y="2.5" width="12" height="19" rx="3.4" />
            <circle class="lamp-red" cx="12" cy="7.2" r="1.9" />
            <circle class="lamp-yellow" cx="12" cy="12" r="1.9" />
            <circle class="lamp-green" cx="12" cy="16.8" r="1.9" />
          </svg>
        </span>
        <h1 class="brand-title">淄博市智慧交通管理系统</h1>
        <p class="brand-sub">ZIBO SMART TRANSPORTATION MANAGEMENT SYSTEM</p>
      </div>

      <el-form class="login-form" @submit.prevent="onLogin">
        <el-form-item>
          <el-input
            v-model="username"
            placeholder="用户名"
            size="large"
            autocomplete="username"
            @keyup.enter="onLogin"
          />
        </el-form-item>
        <el-form-item>
          <el-input
            v-model="password"
            type="password"
            placeholder="密码"
            size="large"
            show-password
            autocomplete="current-password"
            @keyup.enter="onLogin"
          />
        </el-form-item>
        <p v-if="errMsg" class="login-error">{{ errMsg }}</p>
        <el-button
          class="login-btn"
          type="primary"
          native-type="submit"
          size="large"
          :loading="loading"
        >登 录</el-button>
      </el-form>

      <p class="login-copy">本地账号校验 · 不连接数据库</p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { setAuthUser } from '../store'
import { speak } from '../tools/speech'

const route = useRoute()
const router = useRouter()

const username = ref('')
const password = ref('')
const loading = ref(false)
// 错误用卡片内联提示，不用 ElMessage —— toast 默认 z-index(~2000) 低于覆盖层 9999 会被盖住
const errMsg = ref('')

const onLogin = async () => {
  if (loading.value) return
  errMsg.value = ''
  const u = username.value.trim()
  if (!u || !password.value) {
    errMsg.value = '请输入用户名和密码'
    return
  }
  loading.value = true
  try {
    const user = await api.login(u, password.value)
    setAuthUser(user)
    // 登录成功时 speak 必被浏览器放行（刚有点击/回车手势）
    speak('欢迎回来，' + (user.display_name || user.username))
    // 守卫记录的原目标（未登录直敲子页面时回跳）；否则回首页
    router.replace(route.query.redirect || '/')
  } catch (e) {
    errMsg.value = e.message
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
/* 登录页：浅色专业风。原来是「深蓝底 + 蓝光」的科技大屏套路，和登录后的白卡片系统
 * 完全是两套语言，一进来像换了个产品。 */
.login-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999; /* 独立覆盖层，高于 --z-toast，登录前必须压住全站 */
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-sub);
  overflow: hidden;
}

/* 角落淡蓝光晕：极低饱和度，只用来打破纯色平铺，不再做「科技感」 */
.login-decor {
  position: absolute;
  width: 900px;
  height: 900px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(23, 105, 224, 0.07) 0%, transparent 65%);
  pointer-events: none;
}

.login-card {
  position: relative;
  width: 400px;
  padding: 44px 40px 26px;
  border-radius: var(--radius-lg);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
}

.login-brand {
  text-align: center;
  margin-bottom: 30px;
}
.brand-icon {
  display: inline-block;
}
.brand-icon svg {
  display: block;
  width: 40px;
  height: 40px;
  margin: 0 auto;
  fill: var(--primary);
}
.brand-icon .lamp-red {
  fill: var(--danger);
}
.brand-icon .lamp-yellow {
  fill: var(--warn);
}
.brand-icon .lamp-green {
  fill: var(--ok);
}
.brand-title {
  margin: 10px 0 4px;
  font-size: 21px;
  letter-spacing: 3px;
  color: var(--text);
  font-weight: 600;
}
.brand-sub {
  margin: 0;
  font-size: 10px;
  letter-spacing: 1.5px;
  color: var(--text-mute);
}

/* 输入框：白卡片上的默认 Element 样式本来就合适，只调圆角与聚焦色 */
.login-form :deep(.el-input__wrapper) {
  background: var(--bg-sub);
  box-shadow: 0 0 0 1px var(--border) inset;
  border-radius: var(--radius);
}
.login-form :deep(.el-input__wrapper.is-focus) {
  background: var(--bg-panel);
  box-shadow: 0 0 0 1px var(--primary) inset;
}
.login-form :deep(.el-input__inner) {
  color: var(--text);
  font-size: 14px;
}
.login-form :deep(.el-input__inner::placeholder) {
  color: var(--text-mute);
}
.login-form :deep(.el-input__icon) {
  color: var(--text-mute);
}
.login-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.login-btn {
  width: 100%;
  margin-top: 4px;
  font-size: 15px;
  letter-spacing: 8px;
  background: var(--primary);
  border: none;
}
.login-btn:hover {
  background: var(--primary-hover);
}

.login-error {
  margin: 0 0 12px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--danger);
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  text-align: left;
}

.login-copy {
  margin: 10px 0 0;
  font-size: 11px;
  text-align: center;
  color: var(--text-mute);
  letter-spacing: 1px;
}
</style>
