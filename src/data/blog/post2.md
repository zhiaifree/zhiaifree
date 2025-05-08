---
title: "Vue"
description: "Vue遇到的sessionStorage的数据共享使用详解"
pubDate: 2025-05-08
category: "前端"
draft: false
---

# 出现的问题

在vue项目中，遇到一个需求，需要在当前画面打开新的画面，我采用的windows.open()方法打开的新页面，同时传递值使用的是sessionStorage。
希望缓存数据在新画面使用显示后立即删除，但是在新页面删除后却发现原画面的sessionStorage里面还存在这个值。

# 解决的办法及原因分析

解决办法是原画面传递完毕后直接删除，然后在新画面里面再删除一遍。
原因是sessionStorage的值是浏览器页面标签内共享，在通过windows.open()方法打开的新画面会把sessionStorage的值传递过去，但是在其他页面无法共享这个值。
