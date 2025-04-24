---
title: "Vue"
description: "Vue遇到的change事件错误总结"
pubDate: 2025-03-21
category: "前端"
draft: false
---

# 出现的问题111

在项目中使用vue的前端组件框架element-ui，使用其中的复选框组件，当时是想要这个复选框来做删除按钮，实现删除和未删除两种状态，
然后又要监听它的未删除件数，使其不能超过最大件数，所以在从删除到未删除这个状态需要去校验如果释放这条数据会不会超出最大件数。

然而在实际想要监听的过程中只有一个<span style="color: #3b3be9;">@change</span>方法可以调用,所以在<span style="color: #3b3be9;">@change</span>方法里面做了校验，然后在超出件数的时候把按钮的状态从未删除再改成删除。
但是改完之后一直是按钮样式变化了，但是其绑定的值没有发生改变。

# 解决的办法及原因分析

先说解决办法：在<span style="color: #3b3be9;">this.$nextTick()</span>方法里面去改变复选框的值使用
原因是在<span style="color: #3b3be9;">@change</span>方法里面去改变复选框的值的话，是相当于又走了一次<span style="color: #3b3be9;">@change</span>方法，但是在这一阶段<span style="color: #3b3be9;">@change</span>方法只会运行一次，所以复选框绑定的值并没有改变，
所以我们需要去等**dom**更新完毕之后再去变更复选框绑定的值。
