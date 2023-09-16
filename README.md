# PASSWORD

在HomeAssistant中管理我的密码

[![hacs_badge](https://img.shields.io/badge/Home-Assistant-%23049cdb)](https://www.home-assistant.io/)
[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
![visit](https://visitor-badge.laobi.icu/badge?page_id=shaonianzhentan.password&left_text=visit)

## 使用方式

安装完成重启HA，刷新一下页面，在集成里搜索`我的密码`即可

[![Add Integration](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start?domain=password)

## 注意事项

- 本程序采用`3DES数据加密算法`，以HomeAssistant本机MAC地址为`初始化向量IV`，当数据文件迁移时，更换HomeAssistant运行设备后无法解密

- 请保存初始显示UUID，如果设备意外损坏，可通过`UUID、自定义密钥`这两个重要的关键信息解密

- 如果忘记`UUID、自定义密钥`，信息基本是找不回来了

- HomeAssistant里的存储文件位置`.storage/password.json`，请勿手动修改

## 引用项目

- https://github.com/material-components/material-web